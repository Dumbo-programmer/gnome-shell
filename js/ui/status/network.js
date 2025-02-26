// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported NMApplet */
const { Clutter, Gio, GLib, GObject, Meta, NM, Polkit, St } = imports.gi;
const Signals = imports.signals;

const Animation = imports.ui.animation;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const MessageTray = imports.ui.messageTray;
const ModalDialog = imports.ui.modalDialog;
const ModemManager = imports.misc.modemManager;
const Rfkill = imports.ui.status.rfkill;
const Util = imports.misc.util;

const { loadInterfaceXML } = imports.misc.fileUtils;

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(NM.Client, 'new_async');
Gio._promisify(NM.Client.prototype, 'check_connectivity_async');

const NMConnectionCategory = {
    INVALID: 'invalid',
    WIRED: 'wired',
    WIRELESS: 'wireless',
    WWAN: 'wwan',
    VPN: 'vpn',
};

const NMAccessPointSecurity = {
    NONE: 1,
    WEP: 2,
    WPA_PSK: 3,
    WPA2_PSK: 4,
    WPA_ENT: 5,
    WPA2_ENT: 6,
};

var MAX_DEVICE_ITEMS = 4;

// small optimization, to avoid using [] all the time
const NM80211Mode = NM['80211Mode'];
const NM80211ApFlags = NM['80211ApFlags'];
const NM80211ApSecurityFlags = NM['80211ApSecurityFlags'];

var PortalHelperResult = {
    CANCELLED: 0,
    COMPLETED: 1,
    RECHECK: 2,
};

const PortalHelperIface = loadInterfaceXML('org.gnome.Shell.PortalHelper');
const PortalHelperProxy = Gio.DBusProxy.makeProxyWrapper(PortalHelperIface);

function signalToIcon(value) {
    if (value < 20)
        return 'none';
    else if (value < 40)
        return 'weak';
    else if (value < 50)
        return 'ok';
    else if (value < 80)
        return 'good';
    else
        return 'excellent';
}

function ssidToLabel(ssid) {
    let label = NM.utils_ssid_to_utf8(ssid.get_data());
    if (!label)
        label = _("<unknown>");
    return label;
}

function ensureActiveConnectionProps(active) {
    if (!active._primaryDevice) {
        let devices = active.get_devices();
        if (devices.length > 0) {
            // This list is guaranteed to have at most one device in it.
            let device = devices[0]._delegate;
            active._primaryDevice = device;
        }
    }
}

function launchSettingsPanel(panel, ...args) {
    const param = new GLib.Variant('(sav)',
        [panel, args.map(s => new GLib.Variant('s', s))]);
    const platformData = {
        'desktop-startup-id': new GLib.Variant('s',
            `_TIME${global.get_current_time()}`),
    };
    try {
        Gio.DBus.session.call(
            'org.gnome.Settings',
            '/org/gnome/Settings',
            'org.freedesktop.Application',
            'ActivateAction',
            new GLib.Variant('(sava{sv})',
                ['launch-panel', [param], platformData]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null);
    } catch (e) {
        log(`Failed to launch Settings panel: ${e.message}`);
    }
}

var NMConnectionItem = class {
    constructor(section, connection) {
        this._section = section;
        this._connection = connection;
        this._activeConnection = null;

        this._buildUI();
        this._sync();
    }

    _buildUI() {
        this.labelItem = new PopupMenu.PopupMenuItem('');
        this.labelItem.connect('activate', this._toggle.bind(this));

        this.radioItem = new PopupMenu.PopupMenuItem(this._connection.get_id(), false);
        this.radioItem.connect('activate', this._activate.bind(this));
    }

    destroy() {
        this._activeConnection?.disconnectObject(this);
        this.labelItem.destroy();
        this.radioItem.destroy();
    }

    updateForConnection(connection) {
        // connection should always be the same object
        // (and object path) as this._connection, but
        // this can be false if NetworkManager was restarted
        // and picked up connections in a different order
        // Just to be safe, we set it here again

        this._connection = connection;
        this.radioItem.label.text = connection.get_id();
        this._sync();
        this.emit('name-changed');
    }

    getName() {
        return this._connection.get_id();
    }

    isActive() {
        if (this._activeConnection == null)
            return false;

        return this._activeConnection.state <= NM.ActiveConnectionState.ACTIVATED;
    }

    _sync() {
        let isActive = this.isActive();
        this.labelItem.label.text = isActive ? _("Turn Off") : this._section.getConnectLabel();
        this.radioItem.setOrnament(isActive ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this.emit('icon-changed');
    }

    _toggle() {
        if (this._activeConnection == null)
            this._section.activateConnection(this._connection);
        else
            this._section.deactivateConnection(this._activeConnection);

        this._sync();
    }

    _activate() {
        if (this._activeConnection == null)
            this._section.activateConnection(this._connection);

        this._sync();
    }

    _connectionStateChanged(_ac, _newstate, _reason) {
        this._sync();
    }

    setActiveConnection(activeConnection) {
        this._activeConnection?.disconnectObject(this);

        this._activeConnection = activeConnection;

        this._activeConnection?.connectObject('notify::state',
            this._connectionStateChanged.bind(this), this);

        this._sync();
    }
};
Signals.addSignalMethods(NMConnectionItem.prototype);

var NMConnectionSection = class NMConnectionSection {
    constructor(client) {
        if (this.constructor === NMConnectionSection)
            throw new TypeError(`Cannot instantiate abstract type ${this.constructor.name}`);

        this._client = client;

        this._connectionItems = new Map();
        this._connections = [];

        this._labelSection = new PopupMenu.PopupMenuSection();
        this._radioSection = new PopupMenu.PopupMenuSection();

        this.item = new PopupMenu.PopupSubMenuMenuItem('', true);
        this.item.menu.addMenuItem(this._labelSection);
        this.item.menu.addMenuItem(this._radioSection);

        this._client.connectObject('notify::connectivity',
            this._iconChanged.bind(this), this);
    }

    destroy() {
        this._client.disconnectObject(this);
        this.item.destroy();
    }

    _iconChanged() {
        this._sync();
        this.emit('icon-changed');
    }

    _sync() {
        let nItems = this._connectionItems.size;

        this._radioSection.actor.visible = nItems > 1;
        this._labelSection.actor.visible = nItems == 1;

        this.item.label.text = this._getStatus();
        this.item.icon.icon_name = this._getMenuIcon();
    }

    _getMenuIcon() {
        return this.getIndicatorIcon();
    }

    getConnectLabel() {
        return _("Connect");
    }

    _connectionValid(_connection) {
        return true;
    }

    _connectionSortFunction(one, two) {
        return GLib.utf8_collate(one.get_id(), two.get_id());
    }

    _makeConnectionItem(connection) {
        return new NMConnectionItem(this, connection);
    }

    checkConnection(connection) {
        if (!this._connectionValid(connection))
            return;

        // This function is called every time the connection is added or updated.
        // In the usual case, we already added this connection and UUID
        // didn't change. So we need to check if we already have an item,
        // and update it for properties in the connection that changed
        // (the only one we care about is the name)
        // But it's also possible we didn't know about this connection
        // (eg, during coldplug, or because it was updated and suddenly
        // it's valid for this device), in which case we add a new item.

        let item = this._connectionItems.get(connection.get_uuid());
        if (item)
            this._updateForConnection(item, connection);
        else
            this._addConnection(connection);
    }

    _updateForConnection(item, connection) {
        let pos = this._connections.indexOf(connection);

        this._connections.splice(pos, 1);
        pos = Util.insertSorted(this._connections, connection, this._connectionSortFunction.bind(this));
        this._labelSection.moveMenuItem(item.labelItem, pos);
        this._radioSection.moveMenuItem(item.radioItem, pos);

        item.updateForConnection(connection);
    }

    _addConnection(connection) {
        let item = this._makeConnectionItem(connection);
        if (!item)
            return;

        item.connect('icon-changed', () => this._iconChanged());
        item.connect('activation-failed', (o, reason) => {
            this.emit('activation-failed', reason);
        });
        item.connect('name-changed', this._sync.bind(this));

        let pos = Util.insertSorted(this._connections, connection, this._connectionSortFunction.bind(this));
        this._labelSection.addMenuItem(item.labelItem, pos);
        this._radioSection.addMenuItem(item.radioItem, pos);
        this._connectionItems.set(connection.get_uuid(), item);
        this._sync();
    }

    removeConnection(connection) {
        let uuid = connection.get_uuid();
        let item = this._connectionItems.get(uuid);
        if (item == undefined)
            return;

        item.destroy();
        this._connectionItems.delete(uuid);

        let pos = this._connections.indexOf(connection);
        this._connections.splice(pos, 1);

        this._sync();
    }
};
Signals.addSignalMethods(NMConnectionSection.prototype);

var NMConnectionDevice = class NMConnectionDevice extends NMConnectionSection {
    constructor(client, device) {
        super(client);

        if (this.constructor === NMConnectionDevice)
            throw new TypeError(`Cannot instantiate abstract type ${this.constructor.name}`);

        this._device = device;
        this._description = '';

        this._autoConnectItem = this.item.menu.addAction(_("Connect"), this._autoConnect.bind(this));
        this._deactivateItem = this._radioSection.addAction(_("Turn Off"), this.deactivateConnection.bind(this));

        this._device.connectObject(
            'state-changed', this._deviceStateChanged.bind(this),
            'notify::active-connection', this._activeConnectionChanged.bind(this),
            this);
    }

    _canReachInternet() {
        if (this._client.primary_connection != this._device.active_connection)
            return true;

        return this._client.connectivity == NM.ConnectivityState.FULL;
    }

    _autoConnect() {
        let connection = new NM.SimpleConnection();
        this._client.add_and_activate_connection_async(connection, this._device, null, null, null);
    }

    destroy() {
        this._device.disconnectObject(this);

        super.destroy();
    }

    _activeConnectionChanged() {
        if (this._activeConnection) {
            let item = this._connectionItems.get(this._activeConnection.connection.get_uuid());
            item.setActiveConnection(null);
            this._activeConnection = null;
        }

        this._sync();
    }

    _deviceStateChanged(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        /* Emit a notification if activation fails, but don't do it
           if the reason is no secrets, as that indicates the user
           cancelled the agent dialog */
        if (newstate == NM.DeviceState.FAILED &&
            reason != NM.DeviceStateReason.NO_SECRETS)
            this.emit('activation-failed', reason);

        this._sync();
    }

    _connectionValid(connection) {
        return this._device.connection_valid(connection);
    }

    activateConnection(connection) {
        this._client.activate_connection_async(connection, this._device, null, null, null);
    }

    deactivateConnection(_activeConnection) {
        this._device.disconnect(null);
    }

    setDeviceDescription(desc) {
        this._description = desc;
        this._sync();
    }

    _getDescription() {
        return this._description;
    }

    _sync() {
        let nItems = this._connectionItems.size;
        this._autoConnectItem.visible = nItems == 0;
        this._deactivateItem.visible = this._device.state > NM.DeviceState.DISCONNECTED;

        if (this._activeConnection == null) {
            let activeConnection = this._device.active_connection;
            if (activeConnection && activeConnection.connection) {
                let item = this._connectionItems.get(activeConnection.connection.get_uuid());
                if (item) {
                    this._activeConnection = activeConnection;
                    ensureActiveConnectionProps(this._activeConnection);
                    item.setActiveConnection(this._activeConnection);
                }
            }
        }

        super._sync();
    }

    _getStatus() {
        if (!this._device)
            return '';

        switch (this._device.state) {
        case NM.DeviceState.DISCONNECTED:
            /* Translators: %s is a network identifier */
            return _("%s Off").format(this._getDescription());
        case NM.DeviceState.ACTIVATED:
            /* Translators: %s is a network identifier */
            return _("%s Connected").format(this._getDescription());
        case NM.DeviceState.UNMANAGED:
            /* Translators: this is for network devices that are physically present but are not
               under NetworkManager's control (and thus cannot be used in the menu);
               %s is a network identifier */
            return _("%s Unmanaged").format(this._getDescription());
        case NM.DeviceState.DEACTIVATING:
            /* Translators: %s is a network identifier */
            return _("%s Disconnecting").format(this._getDescription());
        case NM.DeviceState.PREPARE:
        case NM.DeviceState.CONFIG:
        case NM.DeviceState.IP_CONFIG:
        case NM.DeviceState.IP_CHECK:
        case NM.DeviceState.SECONDARIES:
            /* Translators: %s is a network identifier */
            return _("%s Connecting").format(this._getDescription());
        case NM.DeviceState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password; %s is a network identifier */
            return _("%s Requires Authentication").format(this._getDescription());
        case NM.DeviceState.UNAVAILABLE:
            // This state is actually a compound of various states (generically unavailable,
            // firmware missing), that are exposed by different properties (whose state may
            // or may not updated when we receive state-changed).
            if (this._device.firmware_missing) {
                /* Translators: this is for devices that require some kind of firmware or kernel
                   module, which is missing; %s is a network identifier */
                return _("Firmware Missing For %s").format(this._getDescription());
            }
            /* Translators: this is for a network device that cannot be activated (for example it
               is disabled by rfkill, or it has no coverage; %s is a network identifier */
            return _("%s Unavailable").format(this._getDescription());
        case NM.DeviceState.FAILED:
            /* Translators: %s is a network identifier */
            return _("%s Connection Failed").format(this._getDescription());
        default:
            log(`Device state invalid, is ${this._device.state}`);
            return 'invalid';
        }
    }
};

var NMDeviceWired = class extends NMConnectionDevice {
    constructor(client, device) {
        super(client, device);

        this.item.menu.addSettingsAction(_("Wired Settings"), 'gnome-network-panel.desktop');
    }

    get category() {
        return NMConnectionCategory.WIRED;
    }

    _hasCarrier() {
        if (this._device instanceof NM.DeviceEthernet)
            return this._device.carrier;
        else
            return true;
    }

    _sync() {
        this.item.visible = this._hasCarrier();
        super._sync();
    }

    getIndicatorIcon() {
        if (this._device.active_connection) {
            let state = this._device.active_connection.state;

            if (state == NM.ActiveConnectionState.ACTIVATING) {
                return 'network-wired-acquiring-symbolic';
            } else if (state == NM.ActiveConnectionState.ACTIVATED) {
                if (this._canReachInternet())
                    return 'network-wired-symbolic';
                else
                    return 'network-wired-no-route-symbolic';
            } else {
                return 'network-wired-disconnected-symbolic';
            }
        } else {
            return 'network-wired-disconnected-symbolic';
        }
    }
};

var NMDeviceModem = class extends NMConnectionDevice {
    constructor(client, device) {
        super(client, device);

        const settingsPanel = this._useWwanPanel()
            ? 'gnome-wwan-panel.desktop'
            : 'gnome-network-panel.desktop';

        this.item.menu.addSettingsAction(_('Mobile Broadband Settings'), settingsPanel);

        this._mobileDevice = null;

        let capabilities = device.current_capabilities;
        if (device.udi.indexOf('/org/freedesktop/ModemManager1/Modem') == 0)
            this._mobileDevice = new ModemManager.BroadbandModem(device.udi, capabilities);
        else if (capabilities & NM.DeviceModemCapabilities.GSM_UMTS)
            this._mobileDevice = new ModemManager.ModemGsm(device.udi);
        else if (capabilities & NM.DeviceModemCapabilities.CDMA_EVDO)
            this._mobileDevice = new ModemManager.ModemCdma(device.udi);
        else if (capabilities & NM.DeviceModemCapabilities.LTE)
            this._mobileDevice = new ModemManager.ModemGsm(device.udi);

        this._mobileDevice?.connectObject(
            'notify::operator-name', this._sync.bind(this),
            'notify::signal-quality', () => this._iconChanged(), this);

        Main.sessionMode.connectObject('updated',
            this._sessionUpdated.bind(this), this);
        this._sessionUpdated();
    }

    get category() {
        return NMConnectionCategory.WWAN;
    }

    _useWwanPanel() {
        // Currently, wwan panel doesn't support CDMA_EVDO modems
        const supportedCaps =
            NM.DeviceModemCapabilities.GSM_UMTS |
            NM.DeviceModemCapabilities.LTE;
        return this._device.current_capabilities & supportedCaps;
    }

    _autoConnect() {
        if (this._useWwanPanel())
            launchSettingsPanel('wwan', 'show-device', this._device.udi);
        else
            launchSettingsPanel('network', 'connect-3g', this._device.get_path());
    }

    _sessionUpdated() {
        this._autoConnectItem.sensitive = Main.sessionMode.hasWindows;
    }

    destroy() {
        this._mobileDevice?.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);

        super.destroy();
    }

    _getStatus() {
        if (!this._client.wwan_hardware_enabled)
            /* Translators: %s is a network identifier */
            return _("%s Hardware Disabled").format(this._getDescription());
        else if (!this._client.wwan_enabled)
            /* Translators: this is for a network device that cannot be activated
               because it's disabled by rfkill (airplane mode); %s is a network identifier */
            return _("%s Disabled").format(this._getDescription());
        else if (this._device.state == NM.DeviceState.ACTIVATED &&
                 this._mobileDevice && this._mobileDevice.operator_name)
            return this._mobileDevice.operator_name;
        else
            return super._getStatus();
    }

    _getMenuIcon() {
        if (!this._client.wwan_enabled)
            return 'network-cellular-disabled-symbolic';

        return this.getIndicatorIcon();
    }

    getIndicatorIcon() {
        if (this._device.active_connection) {
            if (this._device.active_connection.state == NM.ActiveConnectionState.ACTIVATING)
                return 'network-cellular-acquiring-symbolic';

            return this._getSignalIcon();
        } else {
            return 'network-cellular-signal-none-symbolic';
        }
    }

    _getSignalIcon() {
        return `network-cellular-signal-${signalToIcon(this._mobileDevice.signal_quality)}-symbolic`;
    }
};

var NMDeviceBluetooth = class extends NMConnectionDevice {
    constructor(client, device) {
        super(client, device);

        this.item.menu.addSettingsAction(_("Bluetooth Settings"), 'gnome-network-panel.desktop');
    }

    get category() {
        return NMConnectionCategory.WWAN;
    }

    _getDescription() {
        return this._device.name;
    }

    getConnectLabel() {
        return _("Connect to Internet");
    }

    _getMenuIcon() {
        if (!this._device.active_connection)
            return 'network-cellular-disabled-symbolic';

        return this.getIndicatorIcon();
    }

    getIndicatorIcon() {
        if (this._device.active_connection) {
            let state = this._device.active_connection.state;
            if (state == NM.ActiveConnectionState.ACTIVATING)
                return 'network-cellular-acquiring-symbolic';
            else if (state == NM.ActiveConnectionState.ACTIVATED)
                return 'network-cellular-connected-symbolic';
            else
                return 'network-cellular-signal-none-symbolic';
        } else {
            return 'network-cellular-signal-none-symbolic';
        }
    }
};

var NMWirelessDialogItem = GObject.registerClass({
    Signals: {
        'selected': {},
    },
}, class NMWirelessDialogItem extends St.BoxLayout {
    _init(network) {
        this._network = network;
        this._ap = network.accessPoints[0];

        super._init({
            style_class: 'nm-dialog-item',
            can_focus: true,
            reactive: true,
        });

        let action = new Clutter.ClickAction();
        action.connect('clicked', () => this.grab_key_focus());
        this.add_action(action);

        let title = ssidToLabel(this._ap.get_ssid());
        this._label = new St.Label({
            text: title,
            x_expand: true,
        });

        this.label_actor = this._label;
        this.add_child(this._label);

        this._selectedIcon = new St.Icon({
            style_class: 'nm-dialog-icon',
            icon_name: 'object-select-symbolic',
        });
        this.add(this._selectedIcon);

        this._icons = new St.BoxLayout({
            style_class: 'nm-dialog-icons',
            x_align: Clutter.ActorAlign.END,
        });
        this.add_child(this._icons);

        this._secureIcon = new St.Icon({ style_class: 'nm-dialog-icon' });
        if (this._ap._secType != NMAccessPointSecurity.NONE)
            this._secureIcon.icon_name = 'network-wireless-encrypted-symbolic';
        this._icons.add_actor(this._secureIcon);

        this._signalIcon = new St.Icon({ style_class: 'nm-dialog-icon' });
        this._icons.add_actor(this._signalIcon);

        this._sync();
    }

    vfunc_key_focus_in() {
        this.emit('selected');
    }

    _sync() {
        this._signalIcon.icon_name = this._getSignalIcon();
    }

    updateBestAP(ap) {
        this._ap = ap;
        this._sync();
    }

    setActive(isActive) {
        this._selectedIcon.opacity = isActive ? 255 : 0;
    }

    _getSignalIcon() {
        if (this._ap.mode === NM80211Mode.ADHOC)
            return 'network-workgroup-symbolic';
        else
            return `network-wireless-signal-${signalToIcon(this._ap.strength)}-symbolic`;
    }
});

var NMWirelessDialog = GObject.registerClass(
class NMWirelessDialog extends ModalDialog.ModalDialog {
    _init(client, device) {
        super._init({ styleClass: 'nm-dialog' });

        this._client = client;
        this._device = device;

        this._client.connectObject('notify::wireless-enabled',
            this._syncView.bind(this), this);

        this._rfkill = Rfkill.getRfkillManager();
        this._rfkill.connectObject('airplane-mode-changed',
            this._syncView.bind(this), this);

        this._networks = [];
        this._buildLayout();

        let connections = client.get_connections();
        this._connections = connections.filter(
            connection => device.connection_valid(connection));

        device.connectObject(
            'access-point-added', this._accessPointAdded.bind(this),
            'access-point-removed', this._accessPointRemoved.bind(this),
            'notify::active-access-point', this._activeApChanged.bind(this), this);

        // accessPointAdded will also create dialog items
        let accessPoints = device.get_access_points() || [];
        accessPoints.forEach(ap => {
            this._accessPointAdded(this._device, ap);
        });

        this._selectedNetwork = null;
        this._activeApChanged();
        this._updateSensitivity();
        this._syncView();

        this._scanTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, this._onScanTimeout.bind(this));
        GLib.Source.set_name_by_id(this._scanTimeoutId, '[gnome-shell] this._onScanTimeout');
        this._onScanTimeout();

        let id = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.allowSettings)
                return;

            Main.sessionMode.disconnect(id);
            this.close();
        });

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._scanTimeoutId) {
            GLib.source_remove(this._scanTimeoutId);
            this._scanTimeoutId = 0;
        }

        if (this._syncVisibilityId) {
            Meta.later_remove(this._syncVisibilityId);
            this._syncVisibilityId = 0;
        }
    }

    _onScanTimeout() {
        this._device.request_scan_async(null, null);
        return GLib.SOURCE_CONTINUE;
    }

    _activeApChanged() {
        if (this._activeNetwork)
            this._activeNetwork.item.setActive(false);

        this._activeNetwork = null;
        if (this._device.active_access_point) {
            let idx = this._findNetwork(this._device.active_access_point);
            if (idx >= 0)
                this._activeNetwork = this._networks[idx];
        }

        if (this._activeNetwork)
            this._activeNetwork.item.setActive(true);
        this._updateSensitivity();
    }

    _updateSensitivity() {
        let connectSensitive = this._client.wireless_enabled && this._selectedNetwork && (this._selectedNetwork != this._activeNetwork);
        this._connectButton.reactive = connectSensitive;
        this._connectButton.can_focus = connectSensitive;
    }

    _syncView() {
        if (this._rfkill.airplaneMode) {
            this._airplaneBox.show();

            this._airplaneIcon.icon_name = 'airplane-mode-symbolic';
            this._airplaneHeadline.text = _("Airplane Mode is On");
            this._airplaneText.text = _("Wi-Fi is disabled when airplane mode is on.");
            this._airplaneButton.label = _("Turn Off Airplane Mode");

            this._airplaneButton.visible = !this._rfkill.hwAirplaneMode;
            this._airplaneInactive.visible = this._rfkill.hwAirplaneMode;
            this._noNetworksBox.hide();
        } else if (!this._client.wireless_enabled) {
            this._airplaneBox.show();

            this._airplaneIcon.icon_name = 'dialog-information-symbolic';
            this._airplaneHeadline.text = _("Wi-Fi is Off");
            this._airplaneText.text = _("Wi-Fi needs to be turned on in order to connect to a network.");
            this._airplaneButton.label = _("Turn On Wi-Fi");

            this._airplaneButton.show();
            this._airplaneInactive.hide();
            this._noNetworksBox.hide();
        } else {
            this._airplaneBox.hide();

            this._noNetworksBox.visible = this._networks.length == 0;
        }

        if (this._noNetworksBox.visible)
            this._noNetworksSpinner.play();
        else
            this._noNetworksSpinner.stop();
    }

    _buildLayout() {
        let headline = new St.BoxLayout({ style_class: 'nm-dialog-header-hbox' });

        const icon = new St.Icon({
            style_class: 'nm-dialog-header-icon',
            icon_name: 'network-wireless-signal-excellent-symbolic',
        });

        let titleBox = new St.BoxLayout({ vertical: true });
        const title = new St.Label({
            style_class: 'nm-dialog-header',
            text: _('Wi-Fi Networks'),
        });
        const subtitle = new St.Label({
            style_class: 'nm-dialog-subheader',
            text: _('Select a network'),
        });
        titleBox.add(title);
        titleBox.add(subtitle);

        headline.add(icon);
        headline.add(titleBox);

        this.contentLayout.style_class = 'nm-dialog-content';
        this.contentLayout.add(headline);

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });

        this._itemBox = new St.BoxLayout({ vertical: true });
        this._scrollView = new St.ScrollView({ style_class: 'nm-dialog-scroll-view' });
        this._scrollView.set_x_expand(true);
        this._scrollView.set_y_expand(true);
        this._scrollView.set_policy(St.PolicyType.NEVER,
                                    St.PolicyType.AUTOMATIC);
        this._scrollView.add_actor(this._itemBox);
        this._stack.add_child(this._scrollView);

        this._noNetworksBox = new St.BoxLayout({
            vertical: true,
            style_class: 'no-networks-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._noNetworksSpinner = new Animation.Spinner(16);
        this._noNetworksBox.add_actor(this._noNetworksSpinner);
        this._noNetworksBox.add_actor(new St.Label({
            style_class: 'no-networks-label',
            text: _('No Networks'),
        }));
        this._stack.add_child(this._noNetworksBox);

        this._airplaneBox = new St.BoxLayout({
            vertical: true,
            style_class: 'nm-dialog-airplane-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._airplaneIcon = new St.Icon({ icon_size: 48 });
        this._airplaneHeadline = new St.Label({ style_class: 'nm-dialog-airplane-headline headline' });
        this._airplaneText = new St.Label({ style_class: 'nm-dialog-airplane-text' });

        let airplaneSubStack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        this._airplaneButton = new St.Button({ style_class: 'modal-dialog-button button' });
        this._airplaneButton.connect('clicked', () => {
            if (this._rfkill.airplaneMode)
                this._rfkill.airplaneMode = false;
            else
                this._client.wireless_enabled = true;
        });
        airplaneSubStack.add_actor(this._airplaneButton);
        this._airplaneInactive = new St.Label({
            style_class: 'nm-dialog-airplane-text',
            text: _('Use hardware switch to turn off'),
        });
        airplaneSubStack.add_actor(this._airplaneInactive);

        this._airplaneBox.add_child(this._airplaneIcon);
        this._airplaneBox.add_child(this._airplaneHeadline);
        this._airplaneBox.add_child(this._airplaneText);
        this._airplaneBox.add_child(airplaneSubStack);
        this._stack.add_child(this._airplaneBox);

        this.contentLayout.add_child(this._stack);

        this._disconnectButton = this.addButton({
            action: () => this.close(),
            label: _('Cancel'),
            key: Clutter.KEY_Escape,
        });
        this._connectButton = this.addButton({
            action: this._connect.bind(this),
            label: _('Connect'),
            key: Clutter.KEY_Return,
        });
    }

    _connect() {
        let network = this._selectedNetwork;
        if (network.connections.length > 0) {
            let connection = network.connections[0];
            this._client.activate_connection_async(connection, this._device, null, null, null);
        } else {
            let accessPoints = network.accessPoints;
            if ((accessPoints[0]._secType == NMAccessPointSecurity.WPA2_ENT) ||
                (accessPoints[0]._secType == NMAccessPointSecurity.WPA_ENT)) {
                // 802.1x-enabled APs require further configuration, so they're
                // handled in gnome-control-center
                launchSettingsPanel('wifi', 'connect-8021x-wifi',
                    this._getDeviceDBusPath(), accessPoints[0].get_path());
            } else {
                let connection = new NM.SimpleConnection();
                this._client.add_and_activate_connection_async(connection, this._device, accessPoints[0].get_path(), null, null);
            }
        }

        this.close();
    }

    _getDeviceDBusPath() {
        // nm_object_get_path() is shadowed by nm_device_get_path()
        return NM.Object.prototype.get_path.call(this._device);
    }

    _notifySsidCb(accessPoint) {
        if (accessPoint.get_ssid() != null) {
            accessPoint.disconnectObject(this);
            this._accessPointAdded(this._device, accessPoint);
        }
    }

    _getApSecurityType(accessPoint) {
        if (accessPoint._secType)
            return accessPoint._secType;

        let flags = accessPoint.flags;
        let wpaFlags = accessPoint.wpa_flags;
        let rsnFlags = accessPoint.rsn_flags;
        let type;
        if (rsnFlags != NM80211ApSecurityFlags.NONE) {
            /* RSN check first so that WPA+WPA2 APs are treated as RSN/WPA2 */
            if (rsnFlags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
                type = NMAccessPointSecurity.WPA2_ENT;
            else if (rsnFlags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
                type = NMAccessPointSecurity.WPA2_PSK;
        } else if (wpaFlags != NM80211ApSecurityFlags.NONE) {
            if (wpaFlags & NM80211ApSecurityFlags.KEY_MGMT_802_1X)
                type = NMAccessPointSecurity.WPA_ENT;
            else if (wpaFlags & NM80211ApSecurityFlags.KEY_MGMT_PSK)
                type = NMAccessPointSecurity.WPA_PSK;
        } else {
            // eslint-disable-next-line no-lonely-if
            if (flags & NM80211ApFlags.PRIVACY)
                type = NMAccessPointSecurity.WEP;
            else
                type = NMAccessPointSecurity.NONE;
        }

        // cache the found value to avoid checking flags all the time
        accessPoint._secType = type;
        return type;
    }

    _networkSortFunction(one, two) {
        let oneHasConnection = one.connections.length != 0;
        let twoHasConnection = two.connections.length != 0;

        // place known connections first
        // (-1 = good order, 1 = wrong order)
        if (oneHasConnection && !twoHasConnection)
            return -1;
        else if (!oneHasConnection && twoHasConnection)
            return 1;

        let oneAp = one.accessPoints[0] || null;
        let twoAp = two.accessPoints[0] || null;

        if (oneAp != null && twoAp == null)
            return -1;
        else if (oneAp == null && twoAp != null)
            return 1;

        let oneStrength = oneAp.strength;
        let twoStrength = twoAp.strength;

        // place stronger connections first
        if (oneStrength != twoStrength)
            return oneStrength < twoStrength ? 1 : -1;

        let oneHasSecurity = one.security != NMAccessPointSecurity.NONE;
        let twoHasSecurity = two.security != NMAccessPointSecurity.NONE;

        // place secure connections first
        // (we treat WEP/WPA/WPA2 the same as there is no way to
        // take them apart from the UI)
        if (oneHasSecurity && !twoHasSecurity)
            return -1;
        else if (!oneHasSecurity && twoHasSecurity)
            return 1;

        // sort alphabetically
        return GLib.utf8_collate(one.ssidText, two.ssidText);
    }

    _networkCompare(network, accessPoint) {
        if (!network.ssid.equal(accessPoint.get_ssid()))
            return false;
        if (network.mode != accessPoint.mode)
            return false;
        if (network.security != this._getApSecurityType(accessPoint))
            return false;

        return true;
    }

    _findExistingNetwork(accessPoint) {
        for (let i = 0; i < this._networks.length; i++) {
            let network = this._networks[i];
            for (let j = 0; j < network.accessPoints.length; j++) {
                if (network.accessPoints[j] == accessPoint)
                    return { network: i, ap: j };
            }
        }

        return null;
    }

    _findNetwork(accessPoint) {
        if (accessPoint.get_ssid() == null)
            return -1;

        for (let i = 0; i < this._networks.length; i++) {
            if (this._networkCompare(this._networks[i], accessPoint))
                return i;
        }
        return -1;
    }

    _checkConnections(network, accessPoint) {
        this._connections.forEach(connection => {
            if (accessPoint.connection_valid(connection) &&
                !network.connections.includes(connection))
                network.connections.push(connection);
        });
    }

    _accessPointAdded(device, accessPoint) {
        if (accessPoint.get_ssid() == null) {
            // This access point is not visible yet
            // Wait for it to get a ssid
            accessPoint.connectObject('notify::ssid',
                this._notifySsidCb.bind(this), this);
            return;
        }

        let pos = this._findNetwork(accessPoint);
        let network;

        if (pos != -1) {
            network = this._networks[pos];
            if (network.accessPoints.includes(accessPoint)) {
                log('Access point was already seen, not adding again');
                return;
            }

            Util.insertSorted(network.accessPoints, accessPoint, (one, two) => {
                return two.strength - one.strength;
            });
            network.item.updateBestAP(network.accessPoints[0]);
            this._checkConnections(network, accessPoint);

            this._resortItems();
        } else {
            network = {
                ssid: accessPoint.get_ssid(),
                mode: accessPoint.mode,
                security: this._getApSecurityType(accessPoint),
                connections: [],
                item: null,
                accessPoints: [accessPoint],
            };
            network.ssidText = ssidToLabel(network.ssid);
            this._checkConnections(network, accessPoint);

            let newPos = Util.insertSorted(this._networks, network, this._networkSortFunction);
            this._createNetworkItem(network);
            this._itemBox.insert_child_at_index(network.item, newPos);
        }

        this._queueSyncItemVisibility();
        this._syncView();
    }

    _queueSyncItemVisibility() {
        if (this._syncVisibilityId)
            return;

        this._syncVisibilityId = Meta.later_add(
            Meta.LaterType.BEFORE_REDRAW,
            () => {
                const { hasWindows } = Main.sessionMode;
                const { WPA2_ENT, WPA_ENT } = NMAccessPointSecurity;

                for (const network of this._networks) {
                    const [firstAp] = network.accessPoints;
                    network.item.visible =
                        hasWindows ||
                        network.connections.length > 0 ||
                        (firstAp._secType !== WPA2_ENT && firstAp._secType !== WPA_ENT);
                }
                this._syncVisibilityId = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _accessPointRemoved(device, accessPoint) {
        let res = this._findExistingNetwork(accessPoint);

        if (res == null) {
            log('Removing an access point that was never added');
            return;
        }

        let network = this._networks[res.network];
        network.accessPoints.splice(res.ap, 1);

        if (network.accessPoints.length == 0) {
            network.item.destroy();
            this._networks.splice(res.network, 1);
        } else {
            network.item.updateBestAP(network.accessPoints[0]);
            this._resortItems();
        }

        this._syncView();
    }

    _resortItems() {
        let adjustment = this._scrollView.vscroll.adjustment;
        let scrollValue = adjustment.value;

        this._itemBox.remove_all_children();
        this._networks.forEach(network => {
            this._itemBox.add_child(network.item);
        });

        adjustment.value = scrollValue;
    }

    _selectNetwork(network) {
        if (this._selectedNetwork)
            this._selectedNetwork.item.remove_style_pseudo_class('selected');

        this._selectedNetwork = network;
        this._updateSensitivity();

        if (this._selectedNetwork)
            this._selectedNetwork.item.add_style_pseudo_class('selected');
    }

    _createNetworkItem(network) {
        network.item = new NMWirelessDialogItem(network);
        network.item.setActive(network == this._selectedNetwork);
        network.item.hide();
        network.item.connect('selected', () => {
            Util.ensureActorVisibleInScrollView(this._scrollView, network.item);
            this._selectNetwork(network);
        });
        network.item.connect('destroy', () => {
            let keyFocus = global.stage.key_focus;
            if (keyFocus && keyFocus.contains(network.item))
                this._itemBox.grab_key_focus();
        });
    }
});

var NMDeviceWireless = class {
    constructor(client, device) {
        this._client = client;
        this._device = device;

        this._description = '';

        this.item = new PopupMenu.PopupSubMenuMenuItem('', true);
        this.item.menu.addAction(_("Select Network"), this._showDialog.bind(this));

        this._toggleItem = new PopupMenu.PopupMenuItem('');
        this._toggleItem.connect('activate', this._toggleWifi.bind(this));
        this.item.menu.addMenuItem(this._toggleItem);

        this.item.menu.addSettingsAction(_("Wi-Fi Settings"), 'gnome-wifi-panel.desktop');

        this._client.connectObject(
            'notify::wireless-enabled', this._sync.bind(this),
            'notify::wireless-hardware-enabled', this._sync.bind(this),
            'notify::connectivity', this._iconChanged.bind(this), this);

        this._device.connectObject(
            'notify::active-access-point', this._activeApChanged.bind(this),
            'state-changed', this._deviceStateChanged.bind(this), this);

        this._sync();
    }

    get category() {
        return NMConnectionCategory.WIRELESS;
    }

    _iconChanged() {
        this._sync();
        this.emit('icon-changed');
    }

    destroy() {
        this._device.disconnectObject(this);
        this._activeAccessPoint?.disconnectObject(this);
        this._client.disconnectObject(this);

        if (this._dialog) {
            this._dialog.destroy();
            this._dialog = null;
        }

        this.item.destroy();
    }

    _deviceStateChanged(device, newstate, oldstate, reason) {
        if (newstate == oldstate) {
            log('device emitted state-changed without actually changing state');
            return;
        }

        /* Emit a notification if activation fails, but don't do it
           if the reason is no secrets, as that indicates the user
           cancelled the agent dialog */
        if (newstate == NM.DeviceState.FAILED &&
            reason != NM.DeviceStateReason.NO_SECRETS)
            this.emit('activation-failed', reason);

        this._sync();
    }

    _toggleWifi() {
        this._client.wireless_enabled = !this._client.wireless_enabled;
    }

    _showDialog() {
        this._dialog = new NMWirelessDialog(this._client, this._device);
        this._dialog.connect('closed', this._dialogClosed.bind(this));
        this._dialog.open();
    }

    _dialogClosed() {
        this._dialog = null;
    }

    _strengthChanged() {
        this._iconChanged();
    }

    _activeApChanged() {
        this._activeAccessPoint?.disconnectObject(this);

        this._activeAccessPoint = this._device.active_access_point;

        this._activeAccessPoint?.connectObject('notify::strength',
            this._strengthChanged.bind(this), this);

        this._sync();
    }

    _sync() {
        this._toggleItem.label.text = this._client.wireless_enabled ? _("Turn Off") : _("Turn On");
        this._toggleItem.visible = this._client.wireless_hardware_enabled;

        this.item.icon.icon_name = this._getMenuIcon();
        this.item.label.text = this._getStatus();
    }

    setDeviceDescription(desc) {
        this._description = desc;
        this._sync();
    }

    _getStatus() {
        let ap = this._device.active_access_point;

        if (this._isHotSpotMaster())
            /* Translators: %s is a network identifier */
            return _("%s Hotspot Active").format(this._description);
        else if (this._device.state >= NM.DeviceState.PREPARE &&
                 this._device.state < NM.DeviceState.ACTIVATED)
            /* Translators: %s is a network identifier */
            return _("%s Connecting").format(this._description);
        else if (ap)
            return ssidToLabel(ap.get_ssid());
        else if (!this._client.wireless_hardware_enabled)
            /* Translators: %s is a network identifier */
            return _("%s Hardware Disabled").format(this._description);
        else if (!this._client.wireless_enabled)
            /* Translators: %s is a network identifier */
            return _("%s Off").format(this._description);
        else if (this._device.state == NM.DeviceState.DISCONNECTED)
            /* Translators: %s is a network identifier */
            return _("%s Not Connected").format(this._description);
        else
            return '';
    }

    _getMenuIcon() {
        if (!this._client.wireless_enabled)
            return 'network-wireless-disabled-symbolic';

        if (this._device.active_connection)
            return this.getIndicatorIcon();
        else
            return 'network-wireless-signal-none-symbolic';
    }

    _canReachInternet() {
        if (this._client.primary_connection != this._device.active_connection)
            return true;

        return this._client.connectivity == NM.ConnectivityState.FULL;
    }

    _isHotSpotMaster() {
        if (!this._device.active_connection)
            return false;

        let connection = this._device.active_connection.connection;
        if (!connection)
            return false;

        let ip4config = connection.get_setting_ip4_config();
        if (!ip4config)
            return false;

        return ip4config.get_method() == NM.SETTING_IP4_CONFIG_METHOD_SHARED;
    }

    getIndicatorIcon() {
        if (this._device.state < NM.DeviceState.PREPARE)
            return 'network-wireless-disconnected-symbolic';
        if (this._device.state < NM.DeviceState.ACTIVATED)
            return 'network-wireless-acquiring-symbolic';

        if (this._isHotSpotMaster())
            return 'network-wireless-hotspot-symbolic';

        let ap = this._device.active_access_point;
        if (!ap) {
            if (this._device.mode != NM80211Mode.ADHOC)
                log('An active wireless connection, in infrastructure mode, involves no access point?');

            if (this._canReachInternet())
                return 'network-wireless-connected-symbolic';
            else
                return 'network-wireless-no-route-symbolic';
        }

        if (this._canReachInternet())
            return `network-wireless-signal-${signalToIcon(ap.strength)}-symbolic`;
        else
            return 'network-wireless-no-route-symbolic';
    }
};
Signals.addSignalMethods(NMDeviceWireless.prototype);

var NMVpnConnectionItem = class extends NMConnectionItem {
    isActive() {
        if (this._activeConnection == null)
            return false;

        return this._activeConnection.vpn_state != NM.VpnConnectionState.DISCONNECTED;
    }

    _buildUI() {
        this.labelItem = new PopupMenu.PopupMenuItem('');
        this.labelItem.connect('activate', this._toggle.bind(this));

        this.radioItem = new PopupMenu.PopupSwitchMenuItem(this._connection.get_id(), false);
        this.radioItem.connect('toggled', this._toggle.bind(this));
    }

    _sync() {
        let isActive = this.isActive();
        this.labelItem.label.text = isActive ? _("Turn Off") : this._section.getConnectLabel();
        this.radioItem.setToggleState(isActive);
        this.radioItem.setStatus(this._getStatus());
        this.emit('icon-changed');
    }

    _getStatus() {
        if (this._activeConnection == null)
            return null;

        switch (this._activeConnection.vpn_state) {
        case NM.VpnConnectionState.DISCONNECTED:
        case NM.VpnConnectionState.ACTIVATED:
            return null;
        case NM.VpnConnectionState.PREPARE:
        case NM.VpnConnectionState.CONNECT:
        case NM.VpnConnectionState.IP_CONFIG_GET:
            return _("connecting…");
        case NM.VpnConnectionState.NEED_AUTH:
            /* Translators: this is for network connections that require some kind of key or password */
            return _("authentication required");
        case NM.VpnConnectionState.FAILED:
            return _("connection failed");
        default:
            return 'invalid';
        }
    }

    _connectionStateChanged(ac, newstate, reason) {
        if (newstate == NM.VpnConnectionState.FAILED &&
            reason != NM.VpnConnectionStateReason.NO_SECRETS) {
            // FIXME: if we ever want to show something based on reason,
            // we need to convert from NM.VpnConnectionStateReason
            // to NM.DeviceStateReason
            this.emit('activation-failed', reason);
        }

        this.emit('icon-changed');
        super._connectionStateChanged();
    }

    setActiveConnection(activeConnection) {
        this._activeConnection?.disconnectObject(this);

        this._activeConnection = activeConnection;

        this._activeConnection?.connectObject('vpn-state-changed',
            this._connectionStateChanged.bind(this), this);

        this._sync();
    }

    getIndicatorIcon() {
        if (this._activeConnection) {
            if (this._activeConnection.vpn_state < NM.VpnConnectionState.ACTIVATED)
                return 'network-vpn-acquiring-symbolic';
            else
                return 'network-vpn-symbolic';
        } else {
            return '';
        }
    }
};

var NMVpnSection = class extends NMConnectionSection {
    constructor(client) {
        super(client);

        this.item.menu.addSettingsAction(_("VPN Settings"), 'gnome-network-panel.desktop');

        this._sync();
    }

    _sync() {
        let nItems = this._connectionItems.size;
        this.item.visible = nItems > 0;

        super._sync();
    }

    get category() {
        return NMConnectionCategory.VPN;
    }

    _getDescription() {
        return _("VPN");
    }

    _getStatus() {
        let values = this._connectionItems.values();
        for (let item of values) {
            if (item.isActive())
                return item.getName();
        }

        return _("VPN Off");
    }

    _getMenuIcon() {
        return this.getIndicatorIcon() || 'network-vpn-disabled-symbolic';
    }

    activateConnection(connection) {
        this._client.activate_connection_async(connection, null, null, null, null);
    }

    deactivateConnection(activeConnection) {
        this._client.deactivate_connection(activeConnection, null);
    }

    setActiveConnections(vpnConnections) {
        let connections = this._connectionItems.values();
        for (let item of connections)
            item.setActiveConnection(null);

        vpnConnections.forEach(a => {
            if (a.connection) {
                let item = this._connectionItems.get(a.connection.get_uuid());
                item.setActiveConnection(a);
            }
        });
    }

    _makeConnectionItem(connection) {
        return new NMVpnConnectionItem(this, connection);
    }

    getIndicatorIcon() {
        let items = this._connectionItems.values();
        for (let item of items) {
            let icon = item.getIndicatorIcon();
            if (icon)
                return icon;
        }
        return '';
    }
};
Signals.addSignalMethods(NMVpnSection.prototype);

var DeviceCategory = class extends PopupMenu.PopupMenuSection {
    constructor(category) {
        super();

        this._category = category;

        this.devices = [];

        this.section = new PopupMenu.PopupMenuSection();
        this.section.box.connect('actor-added', this._sync.bind(this));
        this.section.box.connect('actor-removed', this._sync.bind(this));
        this.addMenuItem(this.section);

        this._summaryItem = new PopupMenu.PopupSubMenuMenuItem('', true);
        this._summaryItem.icon.icon_name = this._getSummaryIcon();
        this.addMenuItem(this._summaryItem);

        this._summaryItem.menu.addSettingsAction(_('Network Settings'),
                                                 'gnome-network-panel.desktop');
        this._summaryItem.hide();
    }

    _sync() {
        let nDevices = this.section.box.get_children().reduce(
            (prev, child) => prev + (child.visible ? 1 : 0), 0);
        this._summaryItem.label.text = this._getSummaryLabel(nDevices);
        let shouldSummarize = nDevices > MAX_DEVICE_ITEMS;
        this._summaryItem.visible = shouldSummarize;
        this.section.actor.visible = !shouldSummarize;
    }

    _getSummaryIcon() {
        switch (this._category) {
        case NMConnectionCategory.WIRED:
            return 'network-wired-symbolic';
        case NMConnectionCategory.WIRELESS:
        case NMConnectionCategory.WWAN:
            return 'network-wireless-symbolic';
        }
        return '';
    }

    _getSummaryLabel(nDevices) {
        switch (this._category) {
        case NMConnectionCategory.WIRED:
            return ngettext("%s Wired Connection",
                            "%s Wired Connections",
                            nDevices).format(nDevices);
        case NMConnectionCategory.WIRELESS:
            return ngettext("%s Wi-Fi Connection",
                            "%s Wi-Fi Connections",
                            nDevices).format(nDevices);
        case NMConnectionCategory.WWAN:
            return ngettext("%s Modem Connection",
                            "%s Modem Connections",
                            nDevices).format(nDevices);
        }
        return '';
    }
};

var NMApplet = GObject.registerClass(
class Indicator extends PanelMenu.SystemIndicator {
    _init() {
        super._init();

        this._primaryIndicator = this._addIndicator();
        this._vpnIndicator = this._addIndicator();

        // Device types
        this._dtypes = { };
        this._dtypes[NM.DeviceType.ETHERNET] = NMDeviceWired;
        this._dtypes[NM.DeviceType.WIFI] = NMDeviceWireless;
        this._dtypes[NM.DeviceType.MODEM] = NMDeviceModem;
        this._dtypes[NM.DeviceType.BT] = NMDeviceBluetooth;

        // Connection types
        this._ctypes = { };
        this._ctypes[NM.SETTING_WIRED_SETTING_NAME] = NMConnectionCategory.WIRED;
        this._ctypes[NM.SETTING_WIRELESS_SETTING_NAME] = NMConnectionCategory.WIRELESS;
        this._ctypes[NM.SETTING_BLUETOOTH_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NM.SETTING_CDMA_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NM.SETTING_GSM_SETTING_NAME] = NMConnectionCategory.WWAN;
        this._ctypes[NM.SETTING_VPN_SETTING_NAME] = NMConnectionCategory.VPN;

        this._getClient();
    }

    async _getClient() {
        this._client = await NM.Client.new_async(null);

        this._activeConnections = [];
        this._connections = [];
        this._connectivityQueue = [];

        this._mainConnection = null;

        this._notification = null;

        this._nmDevices = [];
        this._devices = { };

        const categories = [
            NMConnectionCategory.WIRED,
            NMConnectionCategory.WIRELESS,
            NMConnectionCategory.WWAN,
        ];
        for (let category of categories) {
            this._devices[category] = new DeviceCategory(category);
            this.menu.addMenuItem(this._devices[category]);
        }

        this._vpnSection = new NMVpnSection(this._client);
        this._vpnSection.connect('activation-failed', this._onActivationFailed.bind(this));
        this._vpnSection.connect('icon-changed', this._updateIcon.bind(this));
        this.menu.addMenuItem(this._vpnSection.item);

        this._readConnections();
        this._readDevices();
        this._syncNMState();
        this._syncMainConnection();
        this._syncVpnConnections();

        this._client.connect('notify::nm-running', this._syncNMState.bind(this));
        this._client.connect('notify::networking-enabled', this._syncNMState.bind(this));
        this._client.connect('notify::state', this._syncNMState.bind(this));
        this._client.connect('notify::primary-connection', this._syncMainConnection.bind(this));
        this._client.connect('notify::activating-connection', this._syncMainConnection.bind(this));
        this._client.connect('notify::active-connections', this._syncVpnConnections.bind(this));
        this._client.connect('notify::connectivity', this._syncConnectivity.bind(this));
        this._client.connect('device-added', this._deviceAdded.bind(this));
        this._client.connect('device-removed', this._deviceRemoved.bind(this));
        this._client.connect('connection-added', this._connectionAdded.bind(this));
        this._client.connect('connection-removed', this._connectionRemoved.bind(this));

        try {
            this._configPermission = await Polkit.Permission.new(
                'org.freedesktop.NetworkManager.network-control', null, null);
        } catch (e) {
            log(`No permission to control network connections: ${e}`);
            this._configPermission = null;
        }

        Main.sessionMode.connect('updated', this._sessionUpdated.bind(this));
        this._sessionUpdated();
    }

    _sessionUpdated() {
        const sensitive =
            !Main.sessionMode.isLocked &&
            this._configPermission && this._configPermission.allowed;
        this.menu.setSensitive(sensitive);
    }

    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source(_("Network Manager"),
                                                  'network-transmit-receive');
            this._source.policy = new MessageTray.NotificationApplicationPolicy('gnome-network-panel');

            this._source.connect('destroy', () => (this._source = null));
            Main.messageTray.add(this._source);
        }
    }

    _readDevices() {
        let devices = this._client.get_devices() || [];
        for (let i = 0; i < devices.length; ++i) {
            try {
                this._deviceAdded(this._client, devices[i], true);
            } catch (e) {
                log(`Failed to add device ${devices[i]}: ${e}`);
            }
        }
        this._syncDeviceNames();
    }

    _notify(iconName, title, text, urgency) {
        if (this._notification)
            this._notification.destroy();

        this._ensureSource();

        let gicon = new Gio.ThemedIcon({ name: iconName });
        this._notification = new MessageTray.Notification(this._source, title, text, { gicon });
        this._notification.setUrgency(urgency);
        this._notification.setTransient(true);
        this._notification.connect('destroy', () => {
            this._notification = null;
        });
        this._source.showNotification(this._notification);
    }

    _onActivationFailed(_device, _reason) {
        // XXX: nm-applet has no special text depending on reason
        // but I'm not sure of this generic message
        this._notify('network-error-symbolic',
                     _("Connection failed"),
                     _("Activation of network connection failed"),
                     MessageTray.Urgency.HIGH);
    }

    _syncDeviceNames() {
        let names = NM.Device.disambiguate_names(this._nmDevices);
        for (let i = 0; i < this._nmDevices.length; i++) {
            let device = this._nmDevices[i];
            let description = names[i];
            if (device._delegate)
                device._delegate.setDeviceDescription(description);
        }
    }

    _deviceAdded(client, device, skipSyncDeviceNames) {
        if (device._delegate) {
            // already seen, not adding again
            return;
        }

        let wrapperClass = this._dtypes[device.get_device_type()];
        if (wrapperClass) {
            let wrapper = new wrapperClass(this._client, device);
            device._delegate = wrapper;
            this._addDeviceWrapper(wrapper);

            this._nmDevices.push(device);
            this._deviceChanged(device, skipSyncDeviceNames);

            device.connect('notify::interface', () => {
                this._deviceChanged(device, false);
            });
        }
    }

    _deviceChanged(device, skipSyncDeviceNames) {
        let wrapper = device._delegate;

        if (!skipSyncDeviceNames)
            this._syncDeviceNames();

        if (wrapper instanceof NMConnectionSection) {
            this._connections.forEach(connection => {
                wrapper.checkConnection(connection);
            });
        }
    }

    _addDeviceWrapper(wrapper) {
        wrapper.connectObject('activation-failed',
            this._onActivationFailed.bind(this), this);

        let section = this._devices[wrapper.category].section;
        section.addMenuItem(wrapper.item);

        let devices = this._devices[wrapper.category].devices;
        devices.push(wrapper);
    }

    _deviceRemoved(client, device) {
        let pos = this._nmDevices.indexOf(device);
        if (pos != -1) {
            this._nmDevices.splice(pos, 1);
            this._syncDeviceNames();
        }

        let wrapper = device._delegate;
        if (!wrapper) {
            log('Removing a network device that was not added');
            return;
        }

        this._removeDeviceWrapper(wrapper);
    }

    _removeDeviceWrapper(wrapper) {
        wrapper.disconnectObject(this);
        wrapper.destroy();

        let devices = this._devices[wrapper.category].devices;
        let pos = devices.indexOf(wrapper);
        devices.splice(pos, 1);
    }

    _getMainConnection() {
        let connection;

        connection = this._client.get_primary_connection();
        if (connection) {
            ensureActiveConnectionProps(connection);
            return connection;
        }

        connection = this._client.get_activating_connection();
        if (connection) {
            ensureActiveConnectionProps(connection);
            return connection;
        }

        return null;
    }

    _syncMainConnection() {
        this._mainConnection?._primaryDevice?.disconnectObject(this);
        this._mainConnection?.disconnectObject(this);

        this._mainConnection = this._getMainConnection();

        if (this._mainConnection) {
            this._mainConnection._primaryDevice?.connectObject('icon-changed',
                this._updateIcon.bind(this), this);
            this._mainConnection.connectObject('notify::state',
                this._mainConnectionStateChanged.bind(this), this);
            this._mainConnectionStateChanged();
        }

        this._updateIcon();
        this._syncConnectivity();
    }

    _syncVpnConnections() {
        let activeConnections = this._client.get_active_connections() || [];
        let vpnConnections = activeConnections.filter(
            a => a instanceof NM.VpnConnection);
        vpnConnections.forEach(a => {
            ensureActiveConnectionProps(a);
        });
        this._vpnSection.setActiveConnections(vpnConnections);

        this._updateIcon();
    }

    _mainConnectionStateChanged() {
        if (this._mainConnection.state == NM.ActiveConnectionState.ACTIVATED && this._notification)
            this._notification.destroy();
    }

    _ignoreConnection(connection) {
        let setting = connection.get_setting_connection();
        if (!setting)
            return true;

        // Ignore slave connections
        if (setting.get_master())
            return true;

        return false;
    }

    _addConnection(connection) {
        if (this._ignoreConnection(connection))
            return;
        if (this._connections.includes(connection)) {
            // connection was already seen
            return;
        }

        connection.connectObject('changed',
            this._updateConnection.bind(this), this);

        this._updateConnection(connection);
        this._connections.push(connection);
    }

    _readConnections() {
        let connections = this._client.get_connections();
        connections.forEach(this._addConnection.bind(this));
    }

    _connectionAdded(client, connection) {
        this._addConnection(connection);
    }

    _connectionRemoved(client, connection) {
        let pos = this._connections.indexOf(connection);
        if (pos != -1)
            this._connections.splice(pos, 1);

        let section = connection._section;

        if (section == NMConnectionCategory.INVALID)
            return;

        if (section == NMConnectionCategory.VPN) {
            this._vpnSection.removeConnection(connection);
        } else {
            let devices = this._devices[section].devices;
            for (let i = 0; i < devices.length; i++) {
                if (devices[i] instanceof NMConnectionSection)
                    devices[i].removeConnection(connection);
            }
        }

        connection.disconnectObject(this);
    }

    _updateConnection(connection) {
        let connectionSettings = connection.get_setting_by_name(NM.SETTING_CONNECTION_SETTING_NAME);
        connection._type = connectionSettings.type;
        connection._section = this._ctypes[connection._type] || NMConnectionCategory.INVALID;

        let section = connection._section;

        if (section == NMConnectionCategory.INVALID)
            return;

        if (section == NMConnectionCategory.VPN) {
            this._vpnSection.checkConnection(connection);
        } else {
            let devices = this._devices[section].devices;
            devices.forEach(wrapper => {
                if (wrapper instanceof NMConnectionSection)
                    wrapper.checkConnection(connection);
            });
        }
    }

    _syncNMState() {
        this.visible = this._client.nm_running;
        this.menu.actor.visible = this._client.networking_enabled;

        this._updateIcon();
        this._syncConnectivity();
    }

    _flushConnectivityQueue() {
        if (this._portalHelperProxy) {
            for (let item of this._connectivityQueue)
                this._portalHelperProxy.CloseRemote(item);
        }

        this._connectivityQueue = [];
    }

    _closeConnectivityCheck(path) {
        let index = this._connectivityQueue.indexOf(path);

        if (index >= 0) {
            if (this._portalHelperProxy)
                this._portalHelperProxy.CloseRemote(path);

            this._connectivityQueue.splice(index, 1);
        }
    }

    async _portalHelperDone(proxy, emitter, parameters) {
        let [path, result] = parameters;

        if (result == PortalHelperResult.CANCELLED) {
            // Keep the connection in the queue, so the user is not
            // spammed with more logins until we next flush the queue,
            // which will happen once they choose a better connection
            // or we get to full connectivity through other means
        } else if (result == PortalHelperResult.COMPLETED) {
            this._closeConnectivityCheck(path);
        } else if (result == PortalHelperResult.RECHECK) {
            try {
                const state = await this._client.check_connectivity_async(null);
                if (state >= NM.ConnectivityState.FULL)
                    this._closeConnectivityCheck(path);
            } catch (e) { }
        } else {
            log(`Invalid result from portal helper: ${result}`);
        }
    }

    _syncConnectivity() {
        if (this._mainConnection == null ||
            this._mainConnection.state != NM.ActiveConnectionState.ACTIVATED) {
            this._flushConnectivityQueue();
            return;
        }

        let isPortal = this._client.connectivity == NM.ConnectivityState.PORTAL;
        // For testing, allow interpreting any value != FULL as PORTAL, because
        // LIMITED (no upstream route after the default gateway) is easy to obtain
        // with a tethered phone
        // NONE is also possible, with a connection configured to force no default route
        // (but in general we should only prompt a portal if we know there is a portal)
        if (GLib.getenv('GNOME_SHELL_CONNECTIVITY_TEST') != null)
            isPortal ||= this._client.connectivity < NM.ConnectivityState.FULL;
        if (!isPortal || Main.sessionMode.isGreeter)
            return;

        let path = this._mainConnection.get_path();
        for (let item of this._connectivityQueue) {
            if (item == path)
                return;
        }

        let timestamp = global.get_current_time();
        if (this._portalHelperProxy) {
            this._portalHelperProxy.AuthenticateRemote(path, '', timestamp);
        } else {
            new PortalHelperProxy(Gio.DBus.session,
                'org.gnome.Shell.PortalHelper',
                '/org/gnome/Shell/PortalHelper',
                (proxy, error) => {
                    if (error) {
                        log(`Error launching the portal helper: ${error}`);
                        return;
                    }

                    this._portalHelperProxy = proxy;
                    proxy.connectSignal('Done', this._portalHelperDone.bind(this));

                    proxy.AuthenticateRemote(path, '', timestamp);
                });
        }

        this._connectivityQueue.push(path);
    }

    _updateIcon() {
        if (!this._client.networking_enabled) {
            this._primaryIndicator.visible = false;
        } else {
            let dev = null;
            if (this._mainConnection)
                dev = this._mainConnection._primaryDevice;

            let state = this._client.get_state();
            let connected = state == NM.State.CONNECTED_GLOBAL;
            this._primaryIndicator.visible = (dev != null) || connected;
            if (dev) {
                this._primaryIndicator.icon_name = dev.getIndicatorIcon();
            } else if (connected) {
                if (this._client.connectivity == NM.ConnectivityState.FULL)
                    this._primaryIndicator.icon_name = 'network-wired-symbolic';
                else
                    this._primaryIndicator.icon_name = 'network-wired-no-route-symbolic';
            }
        }

        this._vpnIndicator.icon_name = this._vpnSection.getIndicatorIcon();
        this._vpnIndicator.visible = this._vpnIndicator.icon_name !== null;
    }
});
