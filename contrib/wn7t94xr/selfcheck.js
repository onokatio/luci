'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
String.prototype.format = function(...args) { let i = 0; return this.replace(/%s|%d|%\.[0-9]f/g, () => String(args[i++])); };

async function check(radioType) {
	// Load entire modules through LuCI; replace only I/O and DOM rendering boundaries.
	const window = { console }, document = {}, E = (...args) => ({ args });
	new Function('window', 'document', 'DOMParser', 'E', '_', 'cbi_update_table',
		fs.readFileSync(path.join(root, 'modules/luci-base/htdocs/luci-static/resources/luci.js'), 'utf8'))(
		window, document, class {}, E, v => v, () => {});
	const L = window.LuCI.prototype;
	const baseclass = await L.require('baseclass'), request = await L.require('request');
	let legacy = true;
	Object.assign(L, {
		hasViewPermission: () => true,
		hasSystemFeature: group => group == 'hostapd' || group == 'wpasupplicant' || (group == 'netifd_legacy' && legacy),
		env: {}
	});
	const configs = {
		wireless: {
			wifi0: { '.type': 'wifi-device', type: radioType, disabled: '1', hwmode: '11beg', htmode: 'HT40', channel: 'auto' },
			wifi1: { '.type': 'wifi-device', type: radioType, hwmode: '11bea', htmode: 'EHT160', channel: '0' },
			wifi2: { '.type': 'wifi-device', type: radioType, hwmode: '11bea', band: '3', htmode: 'EHT320', channel: '0' },
			ath1: { '.type': 'wifi-iface', device: 'wifi1', encryption: 'psk2+ccmp', sae: '1', key: 'test-password' },
			mld0: { '.type': 'wifi-mld', mld_ssid: 'authoritative-mld-ssid' },
			...Object.fromEntries(['ath05', 'ath15', 'ath25'].map((id, i) => [id, {
				'.type': 'wifi-iface', device: 'wifi' + i, mld: 'mld0', ssid: 'test-mlo',
				mode: 'ap', encryption: 'ccmp', sae: '1', key: 'test-password', ieee80211w: '2'
			}]))
		},
		network: { lan: { '.type': 'interface', type: 'bridge', ifname: 'eth1 eth2' }, wan: { '.type': 'interface', ifname: 'eth0' } }
	};
	const data = configs.wireless, grouped = ['ath05', 'ath15', 'ath25'];
	const uci = {
		loadPackage: async () => {}, load: async () => {}, save: async () => {},
		get: (c, s, k) => k == null ? configs[c]?.[s] : configs[c]?.[s]?.[k],
		set: (c, s, k, v) => { configs[c][s][k] = v; },
		unset: (c, s, k) => { delete configs[c][s][k]; },
		sections: (c, t) => Object.entries(configs[c] || {}).filter(([, v]) => !t || v['.type'] == t).map(([id, v]) => ({ '.name': id, ...v }))
	};
	const notices = [];
	const mocks = {
		uci, rpc: { declare: spec => async () => spec.method == 'freqlist' ? [{ channel: 5, mhz: 5975, band: 6 }] : {} },
		ui: { createHandlerFn: () => () => {}, changes: { init: async () => {} }, addNotification: (...args) => notices.push(args) },
		dom: { elem: () => false }, validation: {}, firewall: {}, view: baseclass, poll: { add() {} }, fs: {}, uqr: {}
	};
	const requireModule = L.require;
	L.require = function(name, from) {
		return Object.hasOwn(mocks, name) ? Promise.resolve(mocks[name]) : requireModule.call(this, name, from);
	};
	request.get = async url => {
		const relative = url.substring(url.indexOf('/') + 1).split('?')[0];
		const module = relative.startsWith('view/network/') ? 'luci-mod-network' : 'luci-base';
		return { ok: true, url, text: () => fs.readFileSync(path.join(root, 'modules', module, 'htdocs/luci-static/resources', relative), 'utf8') };
	};
	const form = await L.require('form'), actualNetwork = await L.require('network');
	const sections = [], namedSections = [], dependencies = new Map();
	const depends = form.AbstractValue.prototype.depends;
	form.AbstractValue.prototype.depends = function(...args) {
		if (!dependencies.has(this)) dependencies.set(this, []);
		dependencies.get(this).push(args);
		return depends.apply(this, args);
	};
	form.NamedSection = form.NamedSection.extend({ __init__(...args) { this.super('__init__', args); namedSections.push(this); } });
	form.Map = form.Map.extend({
		section(...args) { const s = this.super('section', args); sections.push(s); return s; },
		render() { return Promise.resolve({ map: this }); }
	});
	let currentId = 'ath15';
	const wifi = {
		getWifiDeviceName: () => data[currentId].device, getName: () => currentId, getIfname: () => currentId,
		getActiveBSSID: () => '02:00:00:00:00:01', get: k => data[currentId][k], ubus: () => null
	};
	mocks.network = {
		getWifiNetwork: async () => wifi,
		getWifiDevice: async id => ({ get: k => data[id][k], getHTModes: () => ['EHT20', 'EHT40'], getHWModes: () => ['ax', 'be'] })
	};
	mocks['tools.widgets'] = { NetworkSelect: form.ListValue, DeviceSelect: form.ListValue, ZoneSelect: form.ListValue };
	const view = await L.require('view.network.wireless');
	await view.render([null, null, null, []]);
	const grid = sections.find(s => s instanceof form.GridSection);
	assert(grid);
	const modal = new form.Map('wireless');
	modal.findElement = () => null;
	let fail = false, saves = 0;
	const callback = () => {};
	const save = modal.save = function(...args) {
		assert.equal(this, modal); assert.deepEqual(args, [callback, true]); saves++;
		if (fail == 'sync') throw new Error('synchronous failure');
		return fail ? Promise.reject(new Error('save rejected')) : Promise.resolve('saved');
	};
	await grid.addModalOptions(modal.section(form.NamedSection, currentId, 'wifi-iface'));
	const iface = namedSections.find(s => s.sectiontype == 'wifi-iface' && s.getOption('encryption'));
	const radio = namedSections.find(s => s.getOption('_freq'));
	assert(iface && radio);
	const frequencyNode = { querySelector: selector => ({ value: ({ '.htmode': 'EHT40', '.mode': 'be', '.band': '2g', '.channel': 'auto' })[selector] }) };
	mocks.dom.findClassInstance = node => node.field;
	modal.findElement = (attribute, id) => {
		const [, , sid, name] = id.split('.');
		const field = (sid.startsWith('wifi') ? radio : iface).getOption(name);
		return field ? { field, classList: { contains: () => name == 'cipher' }, ...frequencyNode } : null;
	};
	const unsupported = ['ppsk', 'dynamic_vlan', 'per_sta_vif', 'vlan_naming', 'vlan_tagged_interface', 'vlan_bridge', 'radius_auth_req_attr', 'radius_acct_req_attr', 'rsn_preauth'];
	for (const name of unsupported) assert.equal(!!iface.getOption(name), radioType != 'qcawificfg80211', name);
	const keyDeps = dependencies.get(iface.getOption('_wpa_key'));
	assert(keyDeps.some(([dep]) => dep.mode == 'ap' && dep.encryption == 'psk2' && (radioType == 'qcawificfg80211' ? !('ppsk' in dep) : dep.ppsk == '0')));
	const radiusDeps = dependencies.get(iface.getOption('auth_server'));
	assert.equal(radiusDeps.some(([dep]) => dep.encryption == 'psk2'), radioType != 'qcawificfg80211');
	assert(radiusDeps.some(([dep]) => dep.encryption == 'wpa3-192'));
	const distance = radio.getOption('distance');
	assert.equal(distance.datatype, radioType == 'qcawificfg80211' ? 'and(uinteger,range(0,21150))' : 'or(range(0,114750),"auto")');
	assert.equal(distance.placeholder, radioType == 'qcawificfg80211' ? '0' : 'auto');
	if (radioType == 'qcawificfg80211') {
		const field = name => iface.getOption(name);
		const shared = (key, value) => { for (const id of grouped) assert.deepEqual(data[id][key], value, id + '.' + key); };
		await field('dtim_period').write('ath15', '3'); shared('dtim_period', '3');
		const alias = field('private_key');
		assert.equal(alias.ucioption, 'priv_key');
		await alias.write('ath15', '/etc/client.key'); shared('priv_key', '/etc/client.key');
		assert.equal(await alias.load('ath15'), '/etc/client.key');
		// An active option using the same storage key must retain its value.
		const activeAlias = iface.option(form.Value, 'active_alias');
		activeAlias.ucioption = 'priv_key'; activeAlias.isActive = () => true;
		await alias.remove('ath15'); shared('priv_key', '/etc/client.key');
		activeAlias.isActive = () => false;
		await alias.remove('ath15'); shared('priv_key', null);
		assert.throws(() => alias.write('ath15', 'bad\npath'));
		await field('wps_pushbutton').write('ath15', '1'); shared('wps', '1');
		await field('wps_pushbutton').remove('ath15'); shared('wps', '0');
		await field('eap_type').write('ath15', 'peap'); shared('eap_type', 'PEAP');
		assert.equal(await field('eap_type').load('ath15'), 'peap');
		await field('r0kh').write('ath15', ['aa,bb,key']); shared('r0kh', ['aa bb key']);
		assert.deepEqual(await field('r0kh').load('ath15'), ['aa,bb,key']);
		for (const value of ['0', '1', '2']) { await field('ieee80211w').write('ath15', value); shared('ieee80211w', value); }
		await field('short_preamble').write('ath1', '1');
		assert.equal(data.ath1.shpreamble, '1'); assert.equal(data.ath15.shpreamble, undefined);
		const encryption = field('encryption');
		let security = 'sae'; encryption.formvalue = () => security;
		const writeSecurity = (id, value) => { security = value; return encryption.write(id, value); };
		assert.notEqual(field('ieee80211w').validate('ath15', '0'), true);
		assert.equal(field('ieee80211w').validate('ath15', '2'), true);
		assert.equal(encryption.validate('ath15', 'sae'), true);
		assert.notEqual(encryption.validate('ath15', 'psk2'), true);
		assert.equal(encryption.validate('ath1', 'psk2'), true);
		assert.throws(() => writeSecurity('ath25', 'psk2'));
		assert.throws(() => writeSecurity('ath05', 'none'));
		assert.throws(() => writeSecurity('ath1', 'unsupported'));
		data.new6 = { device: 'wifi2' };
		assert.notEqual(encryption.validate('new6', 'psk2'), true);
		assert.equal(encryption.validate('new6', 'owe'), true);
		assert.throws(() => writeSecurity('new6', 'none')); delete data.new6;
		for (const [mode, stored] of [['owe', 'ccmp'], ['wpa3-192', 'wpa2+gcmp-256'], ['sae-mixed', 'psk2+ccmp'], ['psk2', 'psk2+ccmp']]) {
			await writeSecurity('ath1', mode); assert.equal(data.ath1.encryption, stored);
			assert.equal(encryption.cfgvalue('ath1'), mode);
		}
		assert.equal(data.ath1.sae, '0');
		await field('_wpa_key').write('ath1', 'test-password');
		await writeSecurity('ath1', 'sae-mixed');
		assert.equal(data.ath1.ieee80211w, '1');
		assert.deepEqual(data.ath1.sae_password, ['test-password']);
		security = 'sae';
		const ssid = field('ssid'), key = field('_wpa_key');
		assert.equal(ssid.cfgvalue('ath15'), 'authoritative-mld-ssid');
		assert.equal(ssid.validate('ath15', '😀'.repeat(8)), true);
		for (const value of ['', '😀'.repeat(9), 'bad\nssid']) assert.notEqual(ssid.validate('ath15', value), true);
		for (const value of ['short', 'password\n', 'password|id=other', 'a'.repeat(64)]) assert.notEqual(key.validate('ath15', value), true);
		security = 'psk2'; assert.equal(key.validate('ath1', 'a'.repeat(64)), true);
		assert.throws(() => key.write('ath15', 'password|id=other'));
		await ssid.write('ath15', 'changed-mlo'); shared('ssid', 'changed-mlo');
		assert.equal(data.mld0.mld_ssid, 'changed-mlo');
		await key.write('ath15', 'new-test-password'); shared('key', 'new-test-password'); shared('sae_password', ['new-test-password']);
		assert.equal(data.ath1.key, 'test-password');
		for (const name of ['hidden', 'macfilter']) { await field(name).write('ath15', '1'); shared(name, '1'); await field(name).remove('ath15'); shared(name, null); }
		const mode = field('mode');
		await mode.write('ath15', 'sta'); shared('mode', 'sta'); assert.equal(data.mld0.role, 'Non-AP');
		mode.formvalue = () => 'sta';
		for (const value of ['lan', 'lan test_dhcp', ['lan', 'test_dhcp']]) assert.notEqual(field('network').validate('ath15', value), true);
		assert.equal(field('network').validate('ath15', ['test_dhcp']), true);
		await mode.write('ath15', 'ap'); shared('mode', 'ap'); assert.equal(data.mld0.role, 'AP');
		const freq = radio.getOption('_freq'); await freq.load('wifi1');
		assert.notEqual(freq.validate('wifi2', ['HE160', '11axa', '0']), true);
		freq.write('wifi2', ['EHT320', '11bea', '0']); assert.equal(data.wifi2.band, '3');
		assert.deepEqual(freq.formvalue('wifi0'), ['HT40', '11beg', 'auto']);
		let hwmode = '11axg'; freq.formvalue = () => ['HE20', hwmode, '1'];
		const frag = field('frag');
		assert.notEqual(frag.validate('ath15', '512'), true); assert.equal(frag.validate('ath15', ''), true);
		hwmode = '11g'; assert.equal(frag.validate('ath15', '512'), true); assert.notEqual(frag.validate('ath15', '513'), true);
		assert.equal(await modal.save(callback, true), 'saved'); fail = true;
		await assert.rejects(modal.save(callback, true), /save rejected/);
		fail = 'sync'; await assert.rejects(modal.save(callback, true), /synchronous failure/);
		assert.equal(saves, 3); assert.equal(notices.length, 2);
	}
	else assert.equal(modal.save, save);
	// Exercise the actual exported protocol with the stock netifd config format.
	actualNetwork.registerProtocol('none', {});
	const lan = actualNetwork.getProtocol('none', 'lan'), wan = actualNetwork.getProtocol('none', 'wan');
	assert.equal(lan.get('device'), 'eth1 eth2');
	wan.set('device', 'eth3'); assert.equal(configs.network.wan.ifname, 'eth3'); assert(!('device' in configs.network.wan));
	wan.set('device', '@lan'); assert.equal(wan.isAlias(), 'lan');
	legacy = false; wan.set('device', 'eth4');
	assert.equal(configs.network.wan.device, 'eth4'); assert.equal(configs.network.wan.ifname, '@lan');
	console.log('PASS: ' + radioType + ' full LuCI loader, public form registration/dependencies, storage/security/MLO and legacy protocol APIs');
}
check('qcawificfg80211').then(() => check('mac80211')).catch(e => { console.error(e); process.exitCode = 1; });
