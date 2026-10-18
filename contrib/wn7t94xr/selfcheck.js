const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
String.prototype.format = function(...args) { let i = 0; return this.replace(/%s|%d|%\.[0-9]f/g, () => String(args[i++])); };
// The native netifd still requires interface-level bridges and ifname lists.
{
	const model = fs.readFileSync(path.join(root, 'modules/luci-base/htdocs/luci-static/resources/network.js'), 'utf8');
	const interfaces = fs.readFileSync(path.join(root, 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/interfaces.js'), 'utf8');
	const helpers = model.slice(model.indexOf('function appendValue'), model.indexOf('function prefixToMask'));
	const protocol = model.slice(model.indexOf('Protocol = baseclass.extend('), model.indexOf('Device = baseclass.extend('));
	let legacy = true;
	const values = { lan: { type: 'bridge', ifname: 'eth1 eth2' }, wan: { ifname: 'eth0' } };
	const state = { get: (c, s, o) => values[s]?.[o], set: (c, s, o, v) => values[s][o] = v,
		unset: (c, s, o) => delete values[s][o], sections: () => [] };
	const L = { hasSystemFeature: () => legacy, toArray: v => Array.isArray(v) ? v : typeof v == 'string' ? v.split(/\s+/).filter(Boolean) : [] };
	const device = name => ({ getName: () => name });
	const factory = new Function('uci', 'L', 'baseclass', 'Network', 'Device', 'ifnameOf', 'getWifiSidByIfname', 'getWifiNetidByNetname', 'deviceSort',
		model.slice(model.indexOf('function getDeviceOption'), model.indexOf('function getWifiStateBySid')) + helpers +
		'let Protocol;\n' + protocol + '\nreturn Protocol;');
	const proto = factory(state, L, { extend: v => v }, { prototype: { instantiateDevice: device } }, device, v => v,
		() => null, () => null, (a, b) => a.getName().localeCompare(b.getName()));
	const lan = Object.assign(Object.create(proto), { sid: 'lan' });
	const wan = Object.assign(Object.create(proto), { sid: 'wan' });
	assert.equal(lan.get('device'), 'eth1 eth2');
	assert.deepEqual(lan.getDevices().map(d => d.getName()), ['eth1', 'eth2']);
	assert(lan.containsDevice('eth2'));
	assert.equal(wan.getDevice().getName(), 'eth0');
	assert.equal(wan.isEmpty(), false);
	assert(wan.addDevice('eth3'));
	assert.equal(values.wan.ifname, 'eth0 eth3');
	assert(!('device' in values.wan));
	assert(wan.deleteDevice('eth0'));
	assert.equal(values.wan.ifname, 'eth3');
	wan.set('device', '@lan');
	assert.equal(wan.isAlias(), 'lan');
	legacy = false;
	wan.set('device', 'eth4');
	assert.equal(values.wan.device, 'eth4');
	assert.equal(wan.getDevice().getName(), 'eth4');
	assert.equal(values.wan.ifname, '@lan');
	assert(interfaces.includes('if (!legacyNetifd && this.interfaceBridgeWithIfnameSections().length)'));
	assert(interfaces.includes("o.ucioption = network.getDeviceOption();"));
	const validate = new Function('L', '_', 'return ' + interfaces.match(/o\.validate = (function\(id, value\) \{\n\s*const bridge =[\s\S]*?\n\s*\});/)[1])(L, v => v);
	const option = { map: { lookupOption: () => [{ formvalue: () => 'bridge' }] } };
	assert.equal(validate.call(option, 'lan', ['eth1', 'eth2']), true);
	option.map.lookupOption = () => [{ formvalue: () => '' }];
	assert.equal(validate.call(option, 'wan', ['eth0']), true);
	assert.notEqual(validate.call(option, 'wan', ['eth0', 'eth1']), true);
}
const wireless = fs.readFileSync(path.join(root, 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js'), 'utf8');
const data = {
	wifi0: { '.type': 'wifi-device', type: 'qcawificfg80211', disabled: '1', hwmode: '11beg', htmode: 'HT40', channel: 'auto' },
	wifi1: { '.type': 'wifi-device', type: 'qcawificfg80211', hwmode: '11bea', htmode: 'EHT160', channel: '0' },
	wifi2: { '.type': 'wifi-device', type: 'qcawificfg80211', hwmode: '11bea', band: '3', htmode: 'EHT320', channel: '0' },
	ath1: { '.type': 'wifi-iface', device: 'wifi1', encryption: 'psk2+ccmp', sae: '1', key: 'test-password' },
	ath05: { '.type': 'wifi-iface', device: 'wifi0', mld: 'mld0', ssid: 'test-mlo', encryption: 'ccmp', sae: '1', key: 'test-password' },
	ath15: { '.type': 'wifi-iface', device: 'wifi1', mld: 'mld0', ssid: 'test-mlo', encryption: 'ccmp', sae: '1', key: 'test-password' },
	ath25: { '.type': 'wifi-iface', device: 'wifi2', mld: 'mld0', ssid: 'test-mlo', encryption: 'ccmp', sae: '1', key: 'test-password' },
	mld0: { '.type': 'wifi-mld', mld_ssid: 'authoritative-mld-ssid' }
};
const uci = {
	get: (config, id, option) => option == null ? data[id] : data[id]?.[option],
	set: (config, id, option, value) => { data[id][option] = value; },
	add: (config, type, id) => { data[id] = { '.type': type }; return id; },
	unset: (config, id, option) => { delete data[id][option]; },
	remove: (config, id) => { delete data[id]; },
	sections: (config, type) => Object.entries(data).filter(([, v]) => v['.type'] == type).map(([id, v]) => ({ '.name': id, ...v }))
};
const helpers = wireless.slice(wireless.indexOf('var qca_shared'), wireless.indexOf('function count_changes'));
const modalStatusCode = wireless.slice(wireless.indexOf('function render_modal_status'), wireless.indexOf('function format_wifirate'));
const modalStatus = new Function('E', '_', modalStatusCode + '\nreturn render_modal_status;')((tag, text) => ({ tag, text }), v => v);
assert.deepEqual(modalStatus(null, undefined), { tag: 'em', text: 'No information available' });
const hiddenStatus = {};
assert.equal(modalStatus(hiddenStatus, undefined), hiddenStatus);
const qca = new Function('uci', '_', helpers + '\nreturn { members: qca_members, setShared: qca_set_shared, security: qca_security, ssid: qca_ssid, writeSecurity: qca_write_security, validSSID: qca_valid_ssid, validKey: qca_valid_key, writeKey: qca_write_key, nextIfname: qca_next_ifname, mlo: qca_mlo, secureBand: qca_secure_band, hwmode: qca_hwmode, removeNetwork: qca_remove_network };')(uci, v => v);
assert.equal(qca.mlo('ath05'), true);
assert.equal(qca.mlo('ath1'), false);
const encryptionCode = wireless.match(/encr\.validate = function\(id, value\) \{[\s\S]*?\n\s*\};/)[0];
const encryption = {};
new Function('encr', 'qca_mlo', 'qca_secure_band', '_', encryptionCode)(encryption, qca.mlo, qca.secureBand, v => v);
assert.equal(encryption.validate('ath15', 'sae'), true);
assert.notEqual(encryption.validate('ath15', 'psk2'), true);
assert.equal(encryption.validate('ath1', 'psk2'), true);

data.new6 = { '.type': 'wifi-iface', device: 'wifi2' };
assert.equal(qca.mlo('new6'), false);
assert.notEqual(encryption.validate('new6', 'psk2'), true);
assert.equal(encryption.validate('new6', 'owe'), true);
assert.throws(() => qca.writeSecurity('new6', 'none'));
delete data.new6;
assert.equal(qca.security('ath1'), 'sae-mixed');
assert.equal(qca.security('ath15'), 'sae');
assert.equal(qca.ssid('ath15'), 'authoritative-mld-ssid');
assert.equal(qca.validSSID('😀'.repeat(8)), true);
assert.equal(qca.validSSID('😀'.repeat(9)), false);
assert.equal(qca.validSSID('bad\nssid'), false);
assert.equal(qca.validKey('a'.repeat(64), 'psk2'), true);
assert.equal(qca.validKey('a'.repeat(64), 'sae'), false);
for (const invalid of ['short', 'password\n', 'password|id=other']) assert.equal(qca.validKey(invalid, 'sae'), false);
assert.throws(() => qca.writeSecurity('ath1', 'unsupported'));
assert.throws(() => qca.writeSecurity('ath25', 'psk2'));
assert.throws(() => qca.writeSecurity('ath05', 'none'));
qca.writeSecurity('ath1', 'owe');
assert.equal(qca.security('ath1'), 'owe');
assert.equal(data.ath1.ieee80211w, '2');
qca.writeSecurity('ath1', 'wpa3-192');
assert.equal(data.ath1.suite_b, '192');
assert.equal(data.ath1.encryption, 'wpa2+gcmp-256');
qca.writeSecurity('ath1', 'sae-mixed');
qca.writeKey('ath1', 'test-password');
qca.setShared('ath15', 'ssid', 'changed-mlo');
qca.writeKey('ath15', 'new-test-password');
for (const id of ['ath05', 'ath15', 'ath25']) {
	assert.equal(data[id].ssid, 'changed-mlo');
	assert.equal(data[id].key, 'new-test-password');
	assert.deepEqual(data[id].sae_password, ['new-test-password']);
}
assert.equal(data.mld0.mld_ssid, 'changed-mlo');
assert.equal(data.ath1.key, 'test-password');
qca.setShared('ath15', 'hidden', '1');
qca.setShared('ath15', 'hidden', null);
for (const id of ['ath05', 'ath15', 'ath25']) assert.equal(data[id].hidden, null);
qca.setShared('ath15', 'macfilter', 'allow');
for (const id of ['ath05', 'ath15', 'ath25']) {
	assert.equal(data[id].macfilter, 'allow');
}
qca.setShared('ath15', 'macfilter', null);
assert.equal(data.ath15.macfilter, null);
qca.writeSecurity('ath1', 'psk2');
assert.equal(data.ath1.sae, '0');
qca.writeSecurity('ath1', 'sae-mixed');
assert.equal(data.ath1.encryption, 'psk2+ccmp');
assert.equal(data.ath1.ieee80211w, '1');
assert.deepEqual(data.ath1.sae_password, ['test-password']);
const rateCode = wireless.slice(wireless.indexOf('function format_wifirate'), wireless.indexOf('function radio_restart'));
const rate = new Function('_', rateCode + '\nreturn format_wifirate;')(v => v);
assert(!rate({ rate: 258000, he: true, mhz: 20, nss: 2 }).includes('MCS'));
assert(rate({ rate: 258000, he: true, mhz: 20, nss: 2 }).includes('NSS\xa02'));
assert(rate({ rate: 5764000, eht: true, mhz: 320, nss: 2 }).includes('320\xa0MHz'));
assert(!rate({ rate: 54000, mhz: 0 }).includes('0\xa0MHz'));
const fragmentCode = wireless.match(/o\.validate = function\(id, value\) \{\n\s*var radio = radioNet.getWifiDeviceName\(\), frequency =[\s\S]*?\n\s*\};/)[0];
const distanceCode = wireless.match(/o = ss\.taboption\('advanced', form\.Value, 'distance',[\s\S]*?o\.placeholder = [^;]+;/)[0];
for (const hwtype of ['qcawificfg80211', 'mac80211']) {
	let distance;
	new Function('ss', 'form', 'hwtype', '_', 'var o; ' + distanceCode)(
		{ taboption: (...args) => (distance = { description: args[4] }) }, { Value: {} }, hwtype, v => v);
	assert.equal(distance.datatype, hwtype == 'qcawificfg80211' ? 'and(uinteger,range(0,21150))' : 'or(range(0,114750),"auto")');
	assert.equal(distance.placeholder, hwtype == 'qcawificfg80211' ? '0' : 'auto');
	if (hwtype == 'qcawificfg80211') assert.match(distance.description, /ACK timeout only.*Automatic estimation is unavailable/);
}
const fragment = {};
new Function('o', 'radioNet', 'uci', '_', fragmentCode)(fragment, { getWifiDeviceName: () => 'wifi0' }, uci, v => v);
let fragmentMode = '11axg';
fragment.map = { lookupOption: () => [{ formvalue: () => ['HE20', fragmentMode, '1'] }] };
assert.notEqual(fragment.validate('ap', '512'), true);
assert.equal(fragment.validate('ap', ''), true);
fragmentMode = '11g';
assert.equal(fragment.validate('ap', '512'), true);
assert.notEqual(fragment.validate('ap', '513'), true);

const cell = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
const child = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
const button = { blur() {}, classList: { add() {} } };
const row = { querySelector: selector => selector == '[data-name="_stat"]' ? cell : selector.endsWith('> div') ? child : button };
const restartCode = wireless.slice(wireless.indexOf('function radio_restart'), wireless.indexOf('function network_updown'));
const restart = new Function('document', 'dom', 'E', '_', restartCode + '\nreturn radio_restart;')(
	{ querySelector: () => row }, { content: (node, value) => { node.content = value; } }, tag => ({ tag }), v => v);
restart('wifi1');
assert.equal(cell.attributes.restart, '');
cell.content = { tag: 'em' }; // Status updates replace children, not the state-bearing cell.
assert.equal(cell.attributes.restart, '');
assert.equal(button.disabled, true);
data.reserved = { '.type': 'wifi-iface', ifname: 'ath17' };
assert.equal(qca.nextIfname({ getName: () => 'wifi1', ubus: () => [{ ifname: 'ath16' }] }), 'ath18');
delete data.reserved;
data.test_mld = { '.type': 'wifi-mld', mld_ssid: 'test' };
data.test_link1 = { '.type': 'wifi-iface', mld: 'test_mld' };
data.test_link2 = { '.type': 'wifi-iface', mld: 'test_mld' };
qca.removeNetwork('test_link1');
assert(data.test_mld && data.test_link2);
qca.removeNetwork('test_link2');
assert(!data.test_mld && data.mld0);
const networkValidateCode = wireless.match(/o\.validate = function\(id, value\) \{\n\s*var mode = this\.map\.lookupOption\('mode'[\s\S]*?\n\s*\};/)[0];
const clientNetwork = { map: { lookupOption: () => [{ formvalue: () => 'sta' }] } };
new Function('o', 'uci', '_', networkValidateCode)(clientNetwork, { get: (config, id) => id == 'lan' ? 'bridge' : undefined }, v => v);
assert.notEqual(clientNetwork.validate('link', 'lan'), true);
assert.notEqual(clientNetwork.validate('link', 'lan test_dhcp'), true);
assert.notEqual(clientNetwork.validate('link', ['lan', 'test_dhcp']), true);
assert.equal(clientNetwork.validate('link', ['test_dhcp']), true);
const modeCode = wireless.slice(wireless.indexOf('mode.write = function(section_id, value)'), wireless.indexOf('mode.cfgvalue = function(section_id)'));
const groupMode = {};
new Function('mode', 'hwtype', 'uci', 'qca_set_shared', modeCode)(groupMode, 'qcawificfg80211', uci, qca.setShared);
groupMode.write('ath15', 'sta');
assert.equal(data.mld0.role, 'Non-AP');
assert.equal(data.ath05.mode, 'sta');
assert.equal(data.ath25.mode, 'sta');
groupMode.write('ath15', 'ap');
assert.equal(data.mld0.role, 'AP');
assert.equal(data.ath05.mode, 'ap');
assert.equal(data.ath25.mode, 'ap');
const addCode = wireless.slice(wireless.indexOf('s.handleAdd = function'), wireless.indexOf("\n\t\to = s.option(form.DummyValue, '_badge')"));
const section = { renderMoreOptionsModal: id => Promise.resolve(id) };
new Function('m', 's', 'uci', 'next_free_sid', 'qca_next_ifname', 'qca_write_security', 'qca_mlo', 'qca_secure_band', addCode)({}, section, uci, () => 'new_ap', qca.nextIfname, qca.writeSecurity, qca.mlo, qca.secureBand);
const networkJS = fs.readFileSync(path.join(root, 'modules/luci-base/htdocs/luci-static/resources/network.js'), 'utf8');
const saveCode = wireless.slice(wireless.indexOf('var modalSave = s.handleModalSave;'), wireless.indexOf('s.handleScan = function'));
const formSource = fs.readFileSync(path.join(root, 'modules/luci-base/htdocs/luci-static/resources/form.js'), 'utf8');
function formMethod(signature, start = 0) {
	const a = formSource.indexOf(signature, start), b = formSource.indexOf('\n\t}', a);
	assert(a >= 0 && b > a);
	return formSource.slice(a + signature.length, b);
}
const valueStart = formSource.indexOf('write(section_id, formvalue) {');
const officialWrite = new Function('section_id', 'formvalue', formMethod('write(section_id, formvalue) {', valueStart));
const officialRemove = new Function('section_id', formMethod('remove(section_id) {', valueStart));
const officialLoad = new Function('section_id', formMethod('load(section_id) {', formSource.indexOf('cbid(section_id) {')));
const fieldForm = { ListValue: { prototype: { write: officialWrite } } };
const frequencyCode = wireless.slice(wireless.indexOf('var CBIWifiFrequencyValue'), wireless.indexOf('var CBIWifiTxPowerValue'));
const optionsStart = wireless.indexOf('ss.children = ss.children.filter');
const optionsEnd = wireless.indexOf('var key = ({', optionsStart);
const nativeOptions = new Function('ss', wireless.slice(optionsStart, optionsEnd) + '}); return ss.children;')({children: [
	{option: 'ppsk'}, {option: 'dynamic_vlan'},
	{option: '_wpa_key', deps: [{encryption: 'psk2', ppsk: '0'}]},
	{option: 'auth_server', deps: [{encryption: 'psk2', ppsk: '1'}, {encryption: 'wpa2'}]}
]});
assert.deepEqual(nativeOptions.map(o => o.option), ['_wpa_key', 'auth_server']);
assert.deepEqual(nativeOptions[0].deps, [{encryption: 'psk2'}]);
assert.deepEqual(nativeOptions[1].deps, [{encryption: 'wpa2'}]);
const nativeSetup = wireless.slice(optionsStart, wireless.indexOf('\n\t\t\t\t\t});', optionsEnd) + '\n\t\t\t\t\t});'.length);
function nativeField(name, write = officialWrite) {
	const section = { children: [] }, field = { option: name, depends() {}, write, remove: officialRemove, load: officialLoad, section, map: {config: 'wireless', data: uci} };
	section.children.push(field);
	new Function('ss', 'uci', 'qca_shared', 'qca_set_shared', 'L', '_', 'form', nativeSetup)(section, uci,
		['priv_key', 'wps_pushbutton', 'eap_type', 'r0kh', 'ieee80211w', 'shpreamble'], qca.setShared, {toArray: v => v == null ? [] : [].concat(v)}, v => v, fieldForm);
	return field;
}
const frequency = new Function('form', 'rpc', 'network', 'uci', 'L', '_', 'qca_hwmode', frequencyCode + '\nreturn CBIWifiFrequencyValue;')(
	{ Value: { extend: v => v } }, { declare: () => () => Promise.resolve([]) },
	{ getWifiDevice: () => Promise.resolve({ get: () => 'qcawificfg80211', getHTModes: () => ['HT20', 'HT40', 'HE20', 'HE40', 'EHT20', 'EHT40'], getHWModes: () => ['ax', 'be'] }) },
	uci, { bind: (fn, ctx) => fn.bind(ctx), hasSystemFeature: () => true, toArray: v => v || [] }, v => v, qca.hwmode);
(async () => {
	let notifications = 0, saves = 0;
	const toggleCode = wireless.slice(wireless.indexOf('function network_updown'), wireless.indexOf('function next_free_sid'));
	const toggle = new Function('uci', 'qca_valid_ssid', 'qca_ssid', 'qca_security', 'qca_valid_key', 'ui', 'E', '_', toggleCode + '\nreturn network_updown;')(
		uci, qca.validSSID, qca.ssid, qca.security, qca.validKey, { addNotification: () => notifications++, changes: { apply() {} } }, () => null, v => v);
	for (const profile of [{ encryption: 'ccmp', owe: '1', mode: 'ap', ssid: 'owe' }, { encryption: 'wpa2+ccmp', mode: 'ap', ssid: 'eap' }, { encryption: 'none', mode: 'monitor' }]) {
		data.toggle = { '.type': 'wifi-iface', device: 'wifi1', disabled: '1', ...profile };
		await toggle('toggle', { save: () => { saves++; return Promise.resolve(); } });
		assert.notEqual(data.toggle.disabled, '1');
	}
	data.toggle = { '.type': 'wifi-iface', device: 'wifi1', disabled: '1', mode: 'ap', ssid: 'psk', encryption: 'psk2+ccmp' };
	await toggle('toggle', { save: () => { saves++; return Promise.resolve(); } });
	assert.equal(data.toggle.disabled, '1');
	assert.equal(saves, 3);
	assert.equal(notifications, 1);
	delete data.toggle;
	await section.handleAdd({ getName: () => 'wifi0', get: option => data.wifi0[option], ubus: () => null });
	assert.equal(data.wifi0.disabled, '1');
	assert.equal(data.new_ap.ifname, 'ath06');
	assert.equal(data.new_ap.disabled, '1');
	assert.deepEqual(data.new_ap.network, ['lan']);
	delete data.new_ap;
	await section.handleAdd({ getName: () => 'wifi2', get: option => data.wifi2[option], ubus: () => null });
	assert.equal(qca.security('new_ap'), 'sae');
	assert.equal(data.new_ap.ieee80211w, '2');
	delete data.new_ap;
	const alias = nativeField('private_key');
	assert.equal(alias.ucioption, 'priv_key');
	await alias.write('ath15', '/etc/client.key');
	for (const id of qca.members('ath15')) assert.equal(data[id].priv_key, '/etc/client.key');
	assert.equal(alias.load('ath15'), '/etc/client.key');
	alias.section.children.push({ ucioption: 'priv_key', map: alias.map, section: alias.section, isActive: () => true });
	await alias.remove('ath15');
	for (const id of qca.members('ath15')) assert.equal(data[id].priv_key, '/etc/client.key');
	alias.section.children.pop();
	await alias.remove('ath15');
	for (const id of qca.members('ath15')) assert.equal(data[id].priv_key, null);
	const wps = nativeField('wps_pushbutton');
	await wps.write('ath15', '1');
	for (const id of qca.members('ath15')) assert.equal(data[id].wps, '1');
	await wps.remove('ath15');
	for (const id of qca.members('ath15')) assert.equal(data[id].wps, '0');
	const eap = nativeField('eap_type'), rkh = nativeField('r0kh');
	await eap.write('ath15', 'peap');
	await rkh.write('ath15', ['aa,bb,key']);
	for (const id of qca.members('ath15')) {
		assert.equal(data[id].eap_type, 'PEAP');
		assert.deepEqual(data[id].r0kh, ['aa bb key']);
	}
	assert.equal(await eap.load('ath15'), 'peap');
	assert.deepEqual(await rkh.load('ath15'), ['aa,bb,key']);
	const pmf = nativeField('ieee80211w', () => { throw new Error('native PMF must stay explicit'); });
	for (const value of ['0', '1', '2']) {
		await pmf.write('ath15', value);
		for (const id of qca.members('ath15')) assert.equal(data[id].ieee80211w, value);
	}
	await nativeField('short_preamble').write('ath1', '1');
	assert.equal(data.ath1.shpreamble, '1');
	assert.equal(data.ath15.shpreamble, undefined);
	assert.throws(() => alias.write('ath15', 'bad\npath'));
	const failing = nativeField('private_key', () => Promise.reject(new Error('upstream rejected')));
	await assert.rejects(failing.write('ath15', 'bad'), /upstream rejected/);
	assert.equal(data.ath15.priv_key, null);
	// Exercise the official modal methods rather than reproducing their lifecycle.
	const L = {bind: (fn, ctx, ...args) => fn.bind(ctx, ...args)};
	let active, hidden = 0, notices = 0;
	const dom = {findClassInstance: () => active}, ui = {hideModal() { hidden++; }, addNotification() { notices++; }};
	assert(wireless.includes("s = m.section(form.GridSection,"));
	assert(formSource.indexOf('handleModalSave(...args) /* ... */{') > formSource.indexOf('const CBIGridSection ='));
	const baseSave = new Function('dom', 'L', 'return function(modalMap,ev){' + formMethod('handleModalSave(modalMap, ev) {') + '}')(dom, L);
	const baseCancel = new Function('dom', 'L', 'ui', 'return function(modalMap,ev){' + formMethod('handleModalCancel(modalMap, ev) {') + '}')(dom, L, ui);
	const gridSave = new Function('...args', formMethod('handleModalSave(...args) /* ... */{'));
	const gridCancel = new Function('modalMap', 'ev', 'isSaving', formMethod('handleModalCancel(modalMap, ev, isSaving) {'));
	let loads = 0, resets = 0, fail = true;
	const modal = {map: {config: 'wireless', addedSection: 'new_ap', data: uci, load: async () => loads++, reset: async () => resets++},
		getActiveModalMap: () => ({}), getPreviousModalMap: () => null, handleModalCancel: gridCancel, handleModalSave: gridSave,
		super(name, args) { return (name == 'handleModalSave' ? baseSave : baseCancel).apply(this, args); }};
	active = { parent: modal.map, save: async (cb, silent) => { assert.equal(silent, true); if (fail) throw new Error('invalid key'); } };
	const originalSave = active.save;
	new Function('s', 'form', 'dom', 'ui', 'E', saveCode)(modal, {}, dom, ui, (tag, text) => ({tag, text}));
	await modal.handleModalSave(active, {});
	assert.equal(modal.map.addedSection, 'new_ap');
	assert.equal(hidden, 0); assert.equal(notices, 1); assert.equal(active.save, originalSave);
	data.new_ap = {};
	await gridCancel.call(modal, active, {}, false);
	assert.equal(data.new_ap, undefined); assert(!('addedSection' in modal.map));
	modal.map.addedSection = 'new_ap'; data.new_ap = {}; fail = false;
	await modal.handleModalSave(active, {});
	assert(data.new_ap); assert(!('addedSection' in modal.map));
	assert.equal(loads, 1); assert.equal(resets, 1); assert.equal(hidden, 2); assert.equal(active.save, originalSave);
	delete data.new_ap;
	await frequency.load('wifi0');
	assert.equal(frequency.htmodes.be[0], 'EHT20');
	assert.equal(frequency.htmodes.be[2].available, true);
	assert.equal(frequency.htmodes.be[3], 'EHT40');
	assert.equal(frequency.htmodes.be[5].available, true);
	assert.equal(data.wifi0.hwmode, '11beg');
	const node = { querySelector: selector => ({ value: selector == '.htmode' ? 'EHT40' : selector == '.mode' ? 'be' : selector == '.band' ? '2g' : 'auto' }) };
	frequency.map = { findElement: () => node };
	frequency.cbid = id => id;
	assert.deepEqual(frequency.formvalue('wifi0'), ['HT40', '11beg', 'auto']);
	assert.notEqual(frequency.validate('wifi2', ['HE160', '11axa', '0']), true);
	frequency.write('wifi2', ['EHT320', '11bea', '0']);
	assert.equal(data.wifi2.hwmode, '11bea');
	assert.equal(data.wifi2.band, '3');
	frequency.callFrequencyList = () => Promise.resolve([{ channel: 5, mhz: 5975, band: 6 }]);
	await frequency.load('wifi2');
	assert(!frequency.modes[2].available);
	assert(!frequency.modes[5].available);
	assert(!frequency.modes[8].available);
	frequency.qca = null;
	frequency.write('wifi1', ['VHT80', '11a', '36']);
	assert.equal(data.wifi1.hwmode, '11a');
	for (const file of ['modules/luci-base/htdocs/luci-static/resources/network.js', 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js', 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/switch.js'])
		new Function(fs.readFileSync(path.join(root, file), 'utf8'));
	assert(!wireless.includes('require tools.qca'));
	for (const removed of ['render_station_details', 'callStationStatistics', 'qca_wireless_actions', 'qca_neighbor_report', 'qsdk_dscp_map', 'atf_enabled']) assert(!wireless.includes(removed));
	assert(wireless.includes('isClientDisconnectSupported()') && wireless.includes('disconnectClient(mac, true, 5, 60000)'));
	assert(wireless.includes("if (hwtype != 'qcawificfg80211') o.value('fast', 'FAST');"));
	console.log('Core Wireless selfcheck passed: AP lifecycle, standard iwinfo frequency routing, failed-save cancellation, MLO, validation and JS syntax');
})().catch(e => { console.error(e); process.exitCode = 1; });
