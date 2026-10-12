'use strict';
'require view';
'require dom';
'require poll';
'require fs';
'require ui';
'require rpc';
'require uci';
'require form';
'require network';
'require firewall';
'require tools.widgets as widgets';

var qca_shared = [ 'hidden', 'isolate', 'macfilter', 'maclist', 'wmm', 'shpreamble', 'dtim_period', 'bintval', 'wpa_group_rekey', 'rts', 'frag', 'skip_inactivity_poll', 'max_inactivity', 'max_listen_interval', 'disassoc_low_ack', 'ieee80211r', 'nasid', 'mobility_domain', 'reassociation_deadline', 'ft_over_ds', 'ft_psk_generate_local', 'r0_key_lifetime', 'r1_key_holder', 'pmk_r1_push', 'r0kh', 'r1kh', 'ieee80211w', 'ieee80211w_max_timeout', 'ieee80211w_retry_timeout', 'wpa_disable_eapol_key_retries', 'auth_server', 'auth_port', 'auth_secret', 'acct_server', 'acct_port', 'acct_secret', 'dae_client', 'dae_port', 'dae_secret', 'wps_pushbutton', 'eap_type', 'pac_file', 'fast_provisioning', 'ca_cert', 'client_cert', 'priv_key', 'priv_key_pwd', 'auth', 'identity', 'anonymous_identity', 'password', 'ca_cert2', 'client_cert2', 'priv_key2', 'priv_key2_pwd', 'auth2', 'altsubject_match', 'altsubject_match2', 'subject_match', 'subject_match2', 'domain_match', 'domain_match2', 'domain_suffix_match', 'domain_suffix_match2' ];

function qca_members(id) {
	var mld = uci.get('wireless', id, 'mld');
	return uci.sections('wireless', 'wifi-iface').filter(function(s) {
		return mld ? s.mld == mld : s['.name'] == id;
	}).map(function(s) { return s['.name']; });
}

function qca_set_shared(id, option, value) {
	qca_members(id).forEach(function(sid) { uci.set('wireless', sid, option, value); });
	if (option == 'ssid') {
		var mld = uci.get('wireless', id, 'mld');
		if (mld) uci.set('wireless', mld, 'mld_ssid', value);
	}
}

function qca_security(id) {
	var enc = uci.get('wireless', id, 'encryption') || 'none',
	    sae = uci.get('wireless', id, 'sae') == '1';
	if (uci.get('wireless', id, 'owe') == '1') return 'owe';
	if (uci.get('wireless', id, 'suite_b') == '192') return 'wpa3-192';
	if (enc.indexOf('wpa2') == 0) return uci.get('wireless', id, 'add_sha256') == '1' ? uci.get('wireless', id, 'ieee80211w') == '2' ? 'wpa3' : 'wpa3-mixed' : 'wpa2';
	if (sae && enc.indexOf('psk2') == 0) return 'sae-mixed';
	if (sae && /^(ccmp|gcmp|sae)/.test(enc)) return 'sae';
	if (!sae && enc.indexOf('psk2') == 0) return 'psk2';
	return enc;
}

function qca_ssid(id) {
	var mld = uci.get('wireless', id, 'mld');
	return (mld && uci.get('wireless', mld, 'mld_ssid')) || uci.get('wireless', id, 'ssid');
}

function qca_mlo(id) {
	return !!uci.get('wireless', id, 'mld');
}

function qca_secure_band(id) {
	return uci.get('wireless', uci.get('wireless', id, 'device'), 'band') == '3';
}

function qca_write_security(id, value) {
	var previous = qca_security(id);
	if ([ 'none', 'psk2', 'sae', 'sae-mixed', 'owe', 'wpa2', 'wpa3', 'wpa3-192', 'wpa3-mixed' ].indexOf(value) < 0 ||
		((qca_mlo(id) || qca_secure_band(id)) && [ 'sae', 'owe', 'wpa3', 'wpa3-192' ].indexOf(value) < 0)) throw new Error('Unsupported encryption mode');
	var sae = value == 'sae' || value == 'sae-mixed';
	var cipher = previous == value ? (uci.get('wireless', id, 'encryption') || '').match(/(ccmp(?:-256)?|gcmp(?:-256)?)$/) : null;
	cipher = value == 'wpa3-192' ? 'gcmp-256' : cipher ? cipher[1] : 'ccmp';
	qca_set_shared(id, 'encryption', value.startsWith('wpa') ? 'wpa2+' + cipher : value == 'sae' || value == 'owe' ? cipher : value == 'none' ? 'none' : 'psk2+' + cipher);
	qca_set_shared(id, 'sae', sae ? '1' : '0');
	qca_set_shared(id, 'owe', value == 'owe' ? '1' : '0');
	qca_set_shared(id, 'suite_b', value == 'wpa3-192' ? '192' : '0');
	qca_set_shared(id, 'add_sha256', value == 'wpa3' || value == 'wpa3-mixed' ? '1' : '0');
	if (previous != value || uci.get('wireless', id, 'ieee80211w') == null ||
		value == 'sae' || value == 'owe' || value == 'wpa3' || value == 'wpa3-192')
		qca_set_shared(id, 'ieee80211w', [ 'sae', 'owe', 'wpa3', 'wpa3-192' ].indexOf(value) >= 0 ? '2' : value == 'sae-mixed' || value == 'wpa3-mixed' ? '1' : '0');
	if ([ 'none', 'owe', 'wpa2', 'wpa3', 'wpa3-192', 'wpa3-mixed' ].indexOf(value) >= 0) {
		qca_set_shared(id, 'key', null);
		qca_set_shared(id, 'sae_password', null);
	}
	if (sae) {
		if (qca_mlo(id) || qca_secure_band(id)) qca_set_shared(id, 'sae_pwe', '1');
		qca_members(id).forEach(function(sid) {
			var key = uci.get('wireless', sid, 'key');
			if (key) uci.set('wireless', sid, 'sae_password', [ key ]);
		});
	}
}

function qca_hwmode(band, mode) {
	return '11' + (mode == 'n' ? 'n' : mode == 'ac' ? 'ac' : mode == 'ax' ? 'ax' : mode == 'be' ? 'be' : '') + (band == '2.4' ? 'g' : 'a');
}

function qca_byte_length(value) { return new TextEncoder().encode(value).length; }

function qca_valid_ssid(value) {
	return value.length > 0 && qca_byte_length(value) <= 32 && !/[\r\n\0]/.test(value);
}

function qca_valid_key(value, mode) {
	if (/[\r\n\0]/.test(value) || (mode != 'psk2' && value.indexOf('|') >= 0)) return false;
	if (mode == 'psk2' && /^[0-9a-fA-F]{64}$/.test(value)) return true;
	return qca_byte_length(value) >= 8 && qca_byte_length(value) <= 63;
}

function qca_write_key(id, value) {
	if (!qca_valid_key(value, qca_security(id))) throw new Error('Invalid wireless key');
	qca_set_shared(id, 'key', value);
	qca_members(id).forEach(function(link) {
		if (uci.get('wireless', link, 'sae') == '1' || uci.get('wireless', link, 'sae_password') != null)
			uci.set('wireless', link, 'sae_password', [ value ]);
	});
}

function qca_next_ifname(radioDev) {
	var prefix = 'ath' + radioDev.getName().replace(/^wifi/, ''),
	    used = uci.sections('wireless', 'wifi-iface').map(function(s) { return s.ifname; })
		.concat((radioDev.ubus('dev', 'interfaces') || []).map(function(s) { return s.ifname; })),
	    index = 6; // Slots 0 to 5 are reserved by the vendor GUI and EasyMesh.
	while (used.indexOf(prefix + index) >= 0) index++;
	return prefix + index;
}

function qca_remove_network(id) {
	var mld = uci.get('wireless', id, 'mld');
	uci.remove('wireless', id);
	if (mld && !uci.sections('wireless', 'wifi-iface').some(function(s) { return s.mld == mld; }))
		uci.remove('wireless', mld);
}

function qca_write_mld(id, value) {
	var previous = uci.get('wireless', id, 'mld'), members;
	if (value == '_new') {
		var index = 3; // The vendor uses mld0 to mld2.
		while (uci.get('wireless', 'mld' + index)) index++;
		value = 'mld' + index;
		uci.add('wireless', 'wifi-mld', value);
		uci.set('wireless', value, 'mld_ssid', uci.get('wireless', id, 'ssid'));
	}
	if (value && (!/^mld[0-9]+$/.test(value) || uci.get('wireless', value, '.type') != 'wifi-mld')) throw new Error(_('Invalid MLO group'));
	if (value != previous) {
		members = uci.sections('wireless', 'wifi-iface').filter(function(s) { return s.mld == value && s['.name'] != id; });
		if (value && members.some(function(s) { return s.device == uci.get('wireless', id, 'device'); })) throw new Error(_('An MLO group can have only one link per radio.'));
		if (value && members.length >= 3) throw new Error(_('An MLO group can have up to three links.'));
		if (value && members.length) {
			[ 'mode', 'wds', 'ssid', 'network', 'encryption', 'key', 'sae', 'sae_pwe', 'owe', 'sae_password', 'suite_b', 'add_sha256', 'wps_pbc', 'wps' ].concat(qca_shared).forEach(function(key) {
				uci.set('wireless', id, key, uci.get('wireless', members[0]['.name'], key));
			});
			uci.set('wireless', id, 'ssid', qca_ssid(members[0]['.name']));
		}
		uci.set('wireless', id, 'mld', value || null);
		if (previous && !uci.sections('wireless', 'wifi-iface').some(function(s) { return s.mld == previous; })) uci.remove('wireless', previous);
	}
	if (value) uci.set('wireless', value, 'role', uci.get('wireless', id, 'mode') == 'sta' ? 'Non-AP' : 'AP');
	return value;
}



function count_changes(section_id) {
	var changes = ui.changes.changes, n = 0;

	if (!L.isObject(changes))
		return n;

	if (Array.isArray(changes.wireless))
		for (var i = 0; i < changes.wireless.length; i++)
			n += (changes.wireless[i][1] == section_id);

	return n;
}

function render_radio_badge(radioDev) {
	return E('span', { 'class': 'ifacebadge' }, [
		E('img', { 'src': L.resource('icons/wifi%s.png').format(radioDev.isUp() ? '' : '_disabled') }),
		' ',
		radioDev.getName()
	]);
}

function render_signal_badge(signalPercent, signalValue, noiseValue, wrap, mode) {
	var icon, title, value;

	if (signalPercent < 0)
		icon = L.resource('icons/signal-none.png');
	else if (signalPercent == 0)
		icon = L.resource('icons/signal-0.png');
	else if (signalPercent < 25)
		icon = L.resource('icons/signal-0-25.png');
	else if (signalPercent < 50)
		icon = L.resource('icons/signal-25-50.png');
	else if (signalPercent < 75)
		icon = L.resource('icons/signal-50-75.png');
	else
		icon = L.resource('icons/signal-75-100.png');

	if (signalValue != null && signalValue != 0) {
		if (noiseValue != null && noiseValue != 0) {
			value = '%d/%d\xa0%s'.format(signalValue, noiseValue, _('dBm'));
			title = '%s: %d %s / %s: %d %s / %s %d'.format(
				_('Signal'), signalValue, _('dBm'),
				_('Noise'), noiseValue, _('dBm'),
				_('SNR'), signalValue - noiseValue);
		}
		else {
			value = '%d\xa0%s'.format(signalValue, _('dBm'));
			title = '%s: %d %s'.format(_('Signal'), signalValue, _('dBm'));
		}
	}
	else if (signalPercent > -1) {
		switch (mode) {
			case 'ap':
				title = _('No client associated');
				break;

			case 'sta':
			case 'adhoc':
			case 'mesh':
				title = _('Not associated');
				break;

			default:
				title = _('No RX signal');
		}

		if (noiseValue != null && noiseValue != 0) {
			value = '---/%d\x0a%s'.format(noiseValue, _('dBm'));
			title = '%s / %s: %d %s'.format(title, _('Noise'), noiseValue, _('dBm'));
		}
		else {
			value = '---\xa0%s'.format(_('dBm'));
		}
	}
	else {
		value = E('em', {}, E('small', {}, [ _('disabled') ]));
		title = _('Interface is disabled');
	}

	return E('div', {
		'class': wrap ? 'center' : 'ifacebadge',
		'title': title,
		'data-signal': signalValue,
		'data-noise': noiseValue
	}, [
		E('img', { 'src': icon }),
		E('span', {}, [
			wrap ? E('br') : ' ',
			value
		])
	]);
}

function render_network_badge(radioNet) {
	return render_signal_badge(
		radioNet.isUp() ? radioNet.getSignalPercent() : -1,
		radioNet.getSignal(), radioNet.getNoise(), false, radioNet.getMode());
}

function render_radio_status(radioDev, wifiNets) {
	var name = radioDev.getI18n().replace(/ Wireless Controller .+$/, ''),
	    node = E('div', [ E('big', {}, E('strong', {}, name)), E('div') ]),
	    channel, frequency, bitrate;

	for (var i = 0; i < wifiNets.length; i++) {
		channel   = channel   || wifiNets[i].getChannel();
		frequency = frequency || wifiNets[i].getFrequency();
		bitrate   = bitrate   || wifiNets[i].getBitRate();
	}

	if (radioDev.isUp())
		L.itemlist(node.lastElementChild, [
			_('Channel'), '%s (%s %s)'.format(channel || '?', frequency || '?', _('GHz')),
			_('Bitrate'), '%s %s'.format(bitrate || '?', _('Mbit/s'))
		], ' | ');
	else
		node.lastElementChild.appendChild(E('em', _('Device is not active')));

	return node;
}

function render_network_status(radioNet) {
	var mode = radioNet.getActiveMode(),
	    bssid = radioNet.getActiveBSSID(),
	    channel = radioNet.getChannel(),
	    disabled = (radioNet.get('disabled') == '1' || uci.get('wireless', radioNet.getWifiDeviceName(), 'disabled') == '1'),
	    is_assoc = (bssid && bssid != '00:00:00:00:00:00' && channel && mode != 'Unknown' && !disabled),
	    is_mesh = (radioNet.getMode() == 'mesh'),
	    changecount = count_changes(radioNet.getName()),
	    status_text = null;

	if (changecount)
		status_text = E('a', {
			href: '#',
			click: L.bind(ui.changes.displayChanges, ui.changes)
		}, _('Interface has %d pending changes').format(changecount));
	else if (!is_assoc)
		status_text = E('em', disabled ? _('Wireless is disabled') : _('Wireless is not associated'));

	return L.itemlist(E('div'), [
		is_mesh ? _('Mesh ID') : _('SSID'), (is_mesh ? radioNet.getMeshID() : radioNet.getSSID()) || '?',
		_('Mode'),       mode,
		_('BSSID'),      (!changecount && is_assoc) ? bssid : null,
		_('Encryption'), (!changecount && is_assoc) ? radioNet.getActiveEncryption() || _('None') : null,
		null,            status_text
	], [ ' | ', E('br') ]);
}

function render_modal_status(node, radioNet) {
	if (!radioNet)
		return node || E('em', _('No information available'));

	var mode = radioNet.getActiveMode(),
	    noise = radioNet.getNoise(),
	    bssid = radioNet.getActiveBSSID(),
	    channel = radioNet.getChannel(),
	    disabled = (radioNet.get('disabled') == '1'),
	    is_assoc = (bssid && bssid != '00:00:00:00:00:00' && channel && mode != 'Unknown' && !disabled);

	if (node == null)
		node = E('span', { 'class': 'ifacebadge large', 'data-network': radioNet.getName() }, [ E('small'), E('span') ]);

	dom.content(node.firstElementChild, render_signal_badge(
		disabled ? -1 : radioNet.getSignalPercent(),
		radioNet.getSignal(), noise, true, radioNet.getMode()));

	L.itemlist(node.lastElementChild, [
		_('Mode'),       mode,
		_('SSID'),       radioNet.getSSID() || '?',
		_('BSSID'),      is_assoc ? bssid : null,
		_('Encryption'), is_assoc ? radioNet.getActiveEncryption() || _('None') : null,
		_('Channel'),    is_assoc ? '%d (%.3f %s)'.format(radioNet.getChannel(), radioNet.getFrequency() || 0, _('GHz')) : null,
		_('Tx-Power'),   is_assoc ? '%d %s'.format(radioNet.getTXPower(), _('dBm')) : null,
		_('Signal'),     is_assoc ? '%d %s'.format(radioNet.getSignal(), _('dBm')) : null,
		_('Noise'),      (is_assoc && noise != null) ? '%d %s'.format(noise, _('dBm')) : null,
		_('Bitrate'),    is_assoc ? '%.1f %s'.format(radioNet.getBitRate() || 0, _('Mbit/s')) : null,
		_('Country'),    is_assoc ? radioNet.getCountryCode() : null
	], [ ' | ', E('br'), E('br'), E('br'), E('br'), E('br'), ' | ', E('br'), ' | ' ]);

	if (!is_assoc)
		dom.append(node.lastElementChild, E('em', disabled ? _('Wireless is disabled') : _('Wireless is not associated')));

	return node;
}

function format_wifirate(rate) {
	var s = '%.1f\xa0%s'.format(rate.rate / 1000, _('Mbit/s')) + (rate.mhz > 0 ? ', %d\xa0%s'.format(rate.mhz, _('MHz')) : ''),
	    ht = rate.ht, vht = rate.vht,
	    mhz = rate.mhz, nss = rate.nss,
	    mcs = rate.mcs, sgi = rate.short_gi;
	if (rate.eht || rate.he) {
		s += ', ' + (rate.eht ? 'EHT' : 'HE');
		if (mcs != null && mcs >= 0) s += '-MCS\xa0%d'.format(mcs);
		if (nss) s += ', NSS\xa0%d'.format(nss);
		return s;
	}

	if (ht || vht) {
		if (vht && mcs != null && mcs >= 0) s += ', VHT-MCS\xa0%d'.format(mcs);
		if (nss) s += ', VHT-NSS\xa0%d'.format(nss);
		if (ht && mcs != null && mcs >= 0) s += ', MCS\xa0%s'.format(mcs);
		if (sgi) s += ', ' + _('Short GI').replace(/ /g, '\xa0');
	}

	return s;
}

function radio_restart(id, ev) {
	var row = document.querySelector('.cbi-section-table-row[data-sid="%s"]'.format(id)),
	    dsc = row.querySelector('[data-name="_stat"]'),
	    btn = row.querySelector('.cbi-section-actions button');

	btn.blur();
	btn.classList.add('spinning');
	btn.disabled = true;

	dsc.setAttribute('restart', '');
	dom.content(dsc, E('em', _('Device is restarting…')));
}

function network_updown(id, map, ev) {
	var radio = uci.get('wireless', id, 'device'),
	    disabled = (uci.get('wireless', id, 'disabled') == '1') ||
	               (uci.get('wireless', radio, 'disabled') == '1');

	if (disabled && uci.get('wireless', radio, 'type') == 'qcawificfg80211' && uci.get('wireless', id, 'mode') != 'monitor' &&
		(!qca_valid_ssid(qca_ssid(id) || '') || ([ 'psk2', 'sae', 'sae-mixed' ].indexOf(qca_security(id)) >= 0 && !qca_valid_key(uci.get('wireless', id, 'key') || '', qca_security(id))))) {
		ui.addNotification(null, E('p', _('Set a valid SSID and key with Edit before enabling this network.')));
		return Promise.resolve();
	}

	if (disabled) {
		uci.unset('wireless', id, 'disabled');
		uci.unset('wireless', radio, 'disabled');
	}
	else {
		uci.set('wireless', id, 'disabled', '1');

		var all_networks_disabled = true,
		    wifi_ifaces = uci.sections('wireless', 'wifi-iface');

		for (var i = 0; i < wifi_ifaces.length; i++) {
			if (wifi_ifaces[i].device == radio && wifi_ifaces[i].disabled != '1') {
				all_networks_disabled = false;
				break;
			}
		}

		if (all_networks_disabled)
			uci.set('wireless', radio, 'disabled', '1');
	}

	return map.save().then(function() {
		ui.changes.apply()
	});
}

function next_free_sid(offset) {
	var sid = 'wifinet' + offset;

	while (uci.get('wireless', sid))
		sid = 'wifinet' + (++offset);

	return sid;
}

function add_dependency_permutations(o, deps) {
	var res = null;

	for (var key in deps) {
		if (!deps.hasOwnProperty(key) || !Array.isArray(deps[key]))
			continue;

		var list = deps[key],
		    tmp = [];

		for (var j = 0; j < list.length; j++) {
			for (var k = 0; k < (res ? res.length : 1); k++) {
				var item = (res ? Object.assign({}, res[k]) : {});
				item[key] = list[j];
				tmp.push(item);
			}
		}

		res = tmp;
	}

	for (var i = 0; i < (res ? res.length : 0); i++)
		o.depends(res[i]);
}

var CBIWifiFrequencyValue = form.Value.extend({
	callFrequencyList: rpc.declare({
		object: 'iwinfo',
		method: 'freqlist',
		params: [ 'device' ],
		expect: { results: [] }
	}),

	load: function(section_id) {
		return Promise.all([
			network.getWifiDevice(section_id),
			this.callFrequencyList(section_id)
		]).then(L.bind(function(data) {
			this.qca = data[0] && data[0].get('type') == 'qcawificfg80211' ? {
				band: uci.get('wireless', section_id, 'band') == '3' ? '6' : uci.get('wireless', section_id, 'hwmode').endsWith('g') ? '2.4' : '5',
				channels: data[1].map(function(c) { return { channel: c.channel, frequency: c.mhz, restricted: c.restricted }; }),
				htmodes: data[0].getHTModes() || [],
				hwmodes: data[0].getHWModes() || []
			} : null;
			if (this.qca) {
				var current = uci.get('wireless', section_id, 'htmode'), width = (current || '').match(/\d+/);
				this.channels = {};
				this.channels[this.qca.band] = [ '0', _('auto'), true ];
				(this.qca.channels || []).forEach(L.bind(function(c) {
					this.channels[this.qca.band].push(String(c.channel), '%d (%.3f GHz)'.format(c.channel, c.frequency / 1000), !c.restricted);
				}, this));
				this.modes = [];
				this.bands = {};
				this.htmodes = {};
				[ ['', _('Legacy'), ''], ['n', 'N', 'HT'], ['ac', 'AC', 'VHT'], ['ax', 'AX', 'HE'], ['be', 'BE', 'EHT'] ].forEach(L.bind(function(m) {
					if ((m[0] && this.qca.hwmodes.indexOf(m[0]) < 0) ||
						(this.qca.band == '6' && m[0] != 'ax' && m[0] != 'be') ||
						(this.qca.band == '2.4' && m[0] == 'ac')) return;
					var hw = qca_hwmode(this.qca.band, m[0]);
					this.modes.push(hw, m[1], true);
					this.bands[hw] = [ this.qca.band, this.qca.band + ' GHz', true ];
					this.htmodes[hw] = m[0] ? [] : [ '', '-', true ];
					this.qca.htmodes.filter(function(v) { return m[0] && v.startsWith(m[2]); }).forEach(L.bind(function(v) {
						var w = v.match(/\d+/)[0];
						this.htmodes[hw].push(hw == uci.get('wireless', section_id, 'hwmode') && width && width[0] == w ? current : v, w + ' MHz', true);
					}, this));
				}, this));
				return;
			}
			this.channels = {
				'11g': L.hasSystemFeature('hostapd', 'acs') ? [ 'auto', 'auto', true ] : [],
				'11a': L.hasSystemFeature('hostapd', 'acs') ? [ 'auto', 'auto', true ] : []
			};

			for (var i = 0; i < data[1].length; i++)
				this.channels[(data[1][i].mhz > 2484) ? '11a' : '11g'].push(
					data[1][i].channel,
					'%d (%d Mhz)'.format(data[1][i].channel, data[1][i].mhz),
					!data[1][i].restricted
				);

			var hwmodelist = L.toArray(data[0] ? data[0].getHWModes() : null)
				.reduce(function(o, v) { o[v] = true; return o }, {});

			this.modes = [
				'', 'Legacy', true,
				'n', 'N', hwmodelist.n,
				'ac', 'AC', hwmodelist.ac
			];

			var htmodelist = L.toArray(data[0] ? data[0].getHTModes() : null)
				.reduce(function(o, v) { o[v] = true; return o }, {});

			this.htmodes = {
				'': [ '', '-', true ],
				'n': [
					'HT20', '20 MHz', htmodelist.HT20,
					'HT40', '40 MHz', htmodelist.HT40
				],
				'ac': [
					'VHT20', '20 MHz', htmodelist.VHT20,
					'VHT40', '40 MHz', htmodelist.VHT40,
					'VHT80', '80 MHz', htmodelist.VHT80,
					'VHT160', '160 MHz', htmodelist.VHT160
				]
			};

			this.bands = {
				'': [
					'11g', '2.4 GHz', this.channels['11g'].length > 3,
					'11a', '5 GHz', this.channels['11a'].length > 3
				],
				'n': [
					'11g', '2.4 GHz', this.channels['11g'].length > 3,
					'11a', '5 GHz', this.channels['11a'].length > 3
				],
				'ac': [
					'11a', '5 GHz', true
				]
			};
		}, this));
	},

	setValues: function(sel, vals) {
		if (sel.vals)
			sel.vals.selected = sel.selectedIndex;

		while (sel.options[0])
			sel.remove(0);

		for (var i = 0; vals && i < vals.length; i += 3)
			if (vals[i+2])
				sel.add(E('option', { value: vals[i+0] }, [ vals[i+1] ]));

		if (vals && !isNaN(vals.selected))
			sel.selectedIndex = vals.selected;

		sel.parentNode.style.display = (sel.options.length <= 1) ? 'none' : '';
		sel.vals = vals;
	},

	toggleWifiMode: function(elem) {
		this.toggleWifiHTMode(elem);
		this.toggleWifiBand(elem);
	},

	toggleWifiHTMode: function(elem) {
		var mode = elem.querySelector('.mode');
		var bwdt = elem.querySelector('.htmode');

		this.setValues(bwdt, this.htmodes[mode.value]);
	},

	toggleWifiBand: function(elem) {
		var mode = elem.querySelector('.mode');
		var band = elem.querySelector('.band');

		this.setValues(band, this.bands[mode.value]);
		this.toggleWifiChannel(elem);
	},

	toggleWifiChannel: function(elem) {
		var band = elem.querySelector('.band');
		var chan = elem.querySelector('.channel');

		this.setValues(chan, this.channels[band.value]);
	},

	setInitialValues: function(section_id, elem) {
		var mode = elem.querySelector('.mode'),
		    band = elem.querySelector('.band'),
		    chan = elem.querySelector('.channel'),
		    bwdt = elem.querySelector('.htmode'),
		    htval = uci.get('wireless', section_id, 'htmode'),
		    hwval = uci.get('wireless', section_id, 'hwmode'),
		    chval = uci.get('wireless', section_id, 'channel');

		this.setValues(mode, this.modes);
		if (this.qca) {
			mode.value = hwval;
			this.toggleWifiMode(elem);
			band.value = this.qca.band;
			this.toggleWifiBand(elem);
			bwdt.value = htval;
			chan.value = chval == 'auto' || chval == null ? '0' : chval;
			return elem;
		}

		if (/VHT20|VHT40|VHT80|VHT160/.test(htval))
			mode.value = 'ac';
		else if (/HT20|HT40/.test(htval))
			mode.value = 'n';
		else
			mode.value = '';

		this.toggleWifiMode(elem);

		if (/a/.test(hwval))
			band.value = '11a';
		else
			band.value = '11g';

		this.toggleWifiBand(elem);

		bwdt.value = htval;
		chan.value = chval;

		return elem;
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var elem = E('div');

		dom.content(elem, [
			E('label', { 'style': 'float:left; margin-right:3px' }, [
				_('Mode'), E('br'),
				E('select', {
					'class': 'mode',
					'style': 'width:auto',
					'change': L.bind(this.toggleWifiMode, this, elem)
				})
			]),
			E('label', { 'style': 'float:left; margin-right:3px' }, [
				_('Band'), E('br'),
				E('select', {
					'class': 'band',
					'style': 'width:auto',
					'change': L.bind(this.toggleWifiBand, this, elem)
				})
			]),
			E('label', { 'style': 'float:left; margin-right:3px' }, [
				_('Channel'), E('br'),
				E('select', {
					'class': 'channel',
					'style': 'width:auto'
				})
			]),
			E('label', { 'style': 'float:left; margin-right:3px' }, [
				_('Width'), E('br'),
				E('select', {
					'class': 'htmode',
					'style': 'width:auto'
				})
			]),
			E('br', { 'style': 'clear:left' })
		]);

		return this.setInitialValues(section_id, elem);
	},

	cfgvalue: function(section_id) {
		return [
		    uci.get('wireless', section_id, 'htmode'),
		    uci.get('wireless', section_id, 'hwmode'),
		    uci.get('wireless', section_id, 'channel')
		];
	},

	formvalue: function(section_id) {
		var node = this.map.findElement('data-field', this.cbid(section_id));

		return [
		    node.querySelector('.htmode').value,
		    this.qca ? node.querySelector('.mode').value : node.querySelector('.band').value,
			this.qca && node.querySelector('.channel').value == '0' && uci.get('wireless', section_id, 'channel') == 'auto' ? 'auto' : node.querySelector('.channel').value
		];
	},

	write: function(section_id, value) {
		uci.set('wireless', section_id, 'htmode', value[0] || null);
		uci.set('wireless', section_id, 'hwmode', value[1]);
		uci.set('wireless', section_id, 'channel', value[2]);
	},

	validate: function(section_id, value) {
		if (this.qca && !value[1].startsWith('11be') &&
			uci.sections('wireless', 'wifi-iface').some(function(s) {
				return s.device == section_id && s.mld && s.disabled != '1';
			})) return _('Disable the MLO links on this radio before selecting a mode other than BE.');
		return true;
	}
});

var CBIWifiTxPowerValue = form.ListValue.extend({
	callTxPowerList: rpc.declare({
		object: 'iwinfo',
		method: 'txpowerlist',
		params: [ 'device' ],
		expect: { results: [] }
	}),

	load: function(section_id) {
		return this.callTxPowerList(section_id).then(L.bind(function(pwrlist) {
			this.powerval = this.wifiNetwork ? this.wifiNetwork.getTXPower() : null;
			this.poweroff = this.wifiNetwork ? this.wifiNetwork.getTXPowerOffset() : null;

			this.value('', _('driver default'));

			for (var i = 0; i < pwrlist.length; i++)
				this.value(pwrlist[i].dbm, '%d dBm (%d mW)'.format(pwrlist[i].dbm, pwrlist[i].mw));

			return form.ListValue.prototype.load.apply(this, [section_id]);
		}, this));
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var widget = form.ListValue.prototype.renderWidget.apply(this, [section_id, option_index, cfgvalue]);
		    widget.firstElementChild.style.width = 'auto';

		dom.append(widget, E('span', [
			' - ', _('Current power'), ': ',
			E('span', [ this.powerval != null ? '%d dBm'.format(this.powerval) : E('em', _('unknown')) ]),
			this.poweroff ? ' + %d dB offset = %s dBm'.format(this.poweroff, this.powerval != null ? this.powerval + this.poweroff : '?') : ''
		]));

		return widget;
	}
});

var CBIWifiCountryValue = form.Value.extend({
	callCountryList: rpc.declare({
		object: 'iwinfo',
		method: 'countrylist',
		params: [ 'device' ],
		expect: { results: [] }
	}),

	load: function(section_id) {
		return this.callCountryList(section_id).then(L.bind(function(countrylist) {
			if (Array.isArray(countrylist) && countrylist.length > 0) {
				this.value('', _('driver default'));

				for (var i = 0; i < countrylist.length; i++)
					this.value(countrylist[i].iso3166, '%s - %s'.format(countrylist[i].iso3166, countrylist[i].country));
			}

			return form.Value.prototype.load.apply(this, [section_id]);
		}, this));
	},

	validate: function(section_id, formvalue) {
		if (formvalue != null && formvalue != '' && !/^[A-Z0-9][A-Z0-9]$/.test(formvalue))
			return _('Use ISO/IEC 3166 alpha2 country codes.');

		return true;
	},

	renderWidget: function(section_id, option_index, cfgvalue) {
		var typeClass = (this.keylist && this.keylist.length) ? form.ListValue : form.Value;
		return typeClass.prototype.renderWidget.apply(this, [section_id, option_index, cfgvalue]);
	}
});

return view.extend({
	poll_status: function(map, data) {
		var rows = map.querySelectorAll('.cbi-section-table-row[data-sid]');

		for (var i = 0; i < rows.length; i++) {
			var section_id = rows[i].getAttribute('data-sid'),
			    radioDev = data[1].filter(function(d) { return d.getName() == section_id })[0],
			    radioNet = data[2].filter(function(n) { return n.getName() == section_id })[0],
			    badge = rows[i].querySelector('[data-name="_badge"] > div'),
			    stat = rows[i].querySelector('[data-name="_stat"]'),
			    btns = rows[i].querySelectorAll('.cbi-section-actions button'),
			    busy = Array.prototype.some.call(btns, function(btn) { return btn.classList.contains('spinning'); }),
			    pending = data[1].some(function(radio) { return radio.ubus('dev', 'pending'); });

			if (radioDev) {
				dom.content(badge, render_radio_badge(radioDev));
				dom.content(stat, render_radio_status(radioDev, data[2].filter(function(n) { return n.getWifiDeviceName() == radioDev.getName() })));
			}
			else {
				dom.content(badge, render_network_badge(radioNet));
				dom.content(stat, render_network_status(radioNet));
			}

			if (stat.hasAttribute('restart') || pending)
				dom.content(stat, E('em', _('Device is restarting…')));

			for (var j = 0; j < btns.length; j++) btns[j].disabled = busy || pending;
		}

		var table = document.querySelector('#wifi_assoclist_table'),
		    hosts = data[0],
		    trows = [];

		for (var i = 0; i < data[3].length; i++) {
			var bss = data[3][i],
			    name = hosts.getHostnameByMACAddr(bss.mac),
			    ipv4 = hosts.getIPAddrByMACAddr(bss.mac),
			    ipv6 = hosts.getIP6AddrByMACAddr(bss.mac);

			var hint;

			if (name && ipv4 && ipv6)
				hint = '%s <span class="hide-xs">(%s, %s)</span>'.format(name, ipv4, ipv6);
			else if (name && (ipv4 || ipv6))
				hint = '%s <span class="hide-xs">(%s)</span>'.format(name, ipv4 || ipv6);
			else
				hint = name || ipv4 || ipv6 || '?';

			var row = [
				E('span', {
					'class': 'ifacebadge',
					'data-ifname': bss.network.getIfname(),
					'data-ssid': bss.network.getSSID()
				}, [
					E('img', {
						'src': L.resource('icons/wifi%s.png').format(bss.network.isUp() ? '' : '_disabled'),
						'title': bss.radio.getI18n()
					}),
					E('span', [
						' %s '.format(bss.network.getShortName()),
						E('small', '(%s)'.format(bss.network.getIfname()))
					])
				]),
				bss.mac,
				hint,
				render_signal_badge(Math.min((bss.signal + 110) / 70 * 100, 100), bss.signal, bss.noise),
				E('span', {}, [
					E('span', format_wifirate(bss.rx)),
					E('br'),
					E('span', format_wifirate(bss.tx))
				])
			];

			if (bss.network.isClientDisconnectSupported()) {
				if (table.firstElementChild.childNodes.length < 6)
					table.firstElementChild.appendChild(E('div', { 'class': 'th cbi-section-actions'}));

				row.push(E('button', {
					'class': 'cbi-button cbi-button-remove',
					'click': L.bind(function(net, mac, ev) {
						dom.parent(ev.currentTarget, '.tr').style.opacity = 0.5;
						ev.currentTarget.classList.add('spinning');
						ev.currentTarget.disabled = true;
						ev.currentTarget.blur();

						net.disconnectClient(mac, true, 5, 60000);
					}, this, bss.network, bss.mac)
				}, [ _('Disconnect') ]));
			}
			else {
				row.push('-');
			}

			trows.push(row);
		}

		cbi_update_table(table, trows, E('em', _('No information available')));

		var stat = document.querySelector('.cbi-modal [data-name="_wifistat_modal"] .ifacebadge.large');

		if (stat)
			render_modal_status(stat, data[2].filter(function(n) { return n.getName() == stat.getAttribute('data-network') })[0]);

		return network.flushCache();
	},

	load: function() {
		return Promise.all([
			uci.changes(),
			uci.load('wireless')
		]);
	},

	checkAnonymousSections: function() {
		var wifiIfaces = uci.sections('wireless', 'wifi-iface');

		for (var i = 0; i < wifiIfaces.length; i++)
			if (wifiIfaces[i]['.anonymous'])
				return true;

		return false;
	},

	callUciRename: rpc.declare({
		object: 'uci',
		method: 'rename',
		params: [ 'config', 'section', 'name' ]
	}),

	render: function() {
		if (this.checkAnonymousSections())
			return this.renderMigration();
		else
			return this.renderOverview();
	},

	handleMigration: function(ev) {
		var wifiIfaces = uci.sections('wireless', 'wifi-iface'),
		    id_offset = 0,
		    tasks = [];

		for (var i = 0; i < wifiIfaces.length; i++) {
			if (!wifiIfaces[i]['.anonymous'])
				continue;

			var new_name = next_free_sid(id_offset);

			tasks.push(this.callUciRename('wireless', wifiIfaces[i]['.name'], new_name));
			id_offset = +new_name.substring(7) + 1;
		}

		return Promise.all(tasks)
			.then(L.bind(ui.changes.init, ui.changes))
			.then(L.bind(ui.changes.apply, ui.changes));
	},

	renderMigration: function() {
		ui.showModal(_('Wireless configuration migration'), [
			E('p', _('The existing wireless configuration needs to be changed for LuCI to function properly.')),
			E('p', _('Upon pressing "Continue", anonymous "wifi-iface" sections will be assigned with a name in the form <em>wifinet#</em> and the network will be restarted to apply the updated configuration.')),
			E('div', { 'class': 'right' },
				E('button', {
					'class': 'btn cbi-button-action important',
					'click': ui.createHandlerFn(this, 'handleMigration')
				}, _('Continue')))
		]);
	},

	renderOverview: function() {
		var m, s, o;

		m = new form.Map('wireless');
		m.chain('network');
		m.chain('firewall');

		s = m.section(form.GridSection, 'wifi-device', _('Wireless Overview'));
		s.anonymous = true;
		s.addremove = false;

		s.load = function() {
			return network.getWifiDevices().then(L.bind(function(radios) {
				this.radios = radios.sort(function(a, b) {
					return a.getName() > b.getName();
				});

				var tasks = [];

				for (var i = 0; i < radios.length; i++)
					tasks.push(radios[i].getWifiNetworks());

				return Promise.all(tasks);
			}, this)).then(L.bind(function(data) {
				this.wifis = [];

				for (var i = 0; i < data.length; i++)
					this.wifis.push.apply(this.wifis, data[i]);
			}, this));
		};

		s.cfgsections = function() {
			var rv = [];

			for (var i = 0; i < this.radios.length; i++) {
				rv.push(this.radios[i].getName());

				for (var j = 0; j < this.wifis.length; j++)
					if (this.wifis[j].getWifiDeviceName() == this.radios[i].getName())
						rv.push(this.wifis[j].getName());
			}

			return rv;
		};

		s.modaltitle = function(section_id) {
			var radioNet = this.wifis.filter(function(w) { return w.getName() == section_id})[0];
			return radioNet ? radioNet.getI18n() : _('Edit wireless network');
		};

		s.lookupRadioOrNetwork = function(section_id) {
			var radioDev = this.radios.filter(function(r) { return r.getName() == section_id })[0];
			if (radioDev)
				return radioDev;

			var radioNet = this.wifis.filter(function(w) { return w.getName() == section_id })[0];
			if (radioNet)
				return radioNet;

			return null;
		};

		s.renderRowActions = function(section_id) {
			var inst = this.lookupRadioOrNetwork(section_id), btns;

			if (inst.getWifiNetworks) {
				btns = [
					E('button', {
						'class': 'cbi-button cbi-button-neutral',
						'title': uci.get('wireless', section_id, 'type') == 'qcawificfg80211' ? _('Restart all radios in the MLO network') : _('Restart radio interface'),
						'click': ui.createHandlerFn(this, radio_restart, section_id)
					}, _('Restart')),
					E('button', {
						'class': 'cbi-button cbi-button-action important',
						'title': inst.get('type') == 'qcawificfg80211' ? _('Scan nearby networks') : _('Find and join network'),
						'click': ui.createHandlerFn(this, 'handleScan', inst)
					}, _('Scan')),
					E('button', {
						'class': 'cbi-button cbi-button-add',
						'title': _('Provide new network'),
						'click': ui.createHandlerFn(this, 'handleAdd', inst)
					}, _('Add'))
				];
			}
			else {
				var isDisabled = (inst.get('disabled') == '1' ||
					uci.get('wireless', inst.getWifiDeviceName(), 'disabled') == '1');

				btns = [
					E('button', {
						'class': 'cbi-button cbi-button-neutral enable-disable',
						'title': isDisabled ? _('Enable this network') : _('Disable this network'),
						'click': ui.createHandlerFn(this, network_updown, section_id, this.map)
					}, isDisabled ? _('Enable') : _('Disable')),
					E('button', {
						'class': 'cbi-button cbi-button-action important',
						'title': _('Edit this network'),
						'click': ui.createHandlerFn(this, 'renderMoreOptionsModal', section_id)
					}, _('Edit')),
					E('button', {
						'class': 'cbi-button cbi-button-negative remove',
						'title': _('Delete this network'),
						'click': ui.createHandlerFn(this, 'handleRemove', section_id)
					}, _('Remove'))
				];
			}

			return E('div', { 'class': 'td middle cbi-section-actions' }, E('div', btns));
		};

		s.addModalOptions = function(s) {
			return network.getWifiNetwork(s.section).then(function(radioNet) {
				var hwtype = uci.get('wireless', radioNet.getWifiDeviceName(), 'type');
				var o, ss;

				o = s.option(form.SectionValue, '_device', form.NamedSection, radioNet.getWifiDeviceName(), 'wifi-device', _('Device Configuration'));
				o.modalonly = true;

				ss = o.subsection;
				ss.tab('general', _('General Setup'));
				ss.tab('advanced', _('Advanced Settings'));

				var isDisabled = (radioNet.get('disabled') == '1' ||
					uci.get('wireless', radioNet.getWifiDeviceName(), 'disabled') == 1);

				o = ss.taboption('general', form.DummyValue, '_wifistat_modal', _('Status'));
				o.cfgvalue = L.bind(function(radioNet) {
					return render_modal_status(null, radioNet);
				}, this, radioNet);
				o.write = function() {};

				o = ss.taboption('general', form.Button, '_toggle', isDisabled ? _('Wireless network is disabled') : _('Wireless network is enabled'));
				o.inputstyle = isDisabled ? 'apply' : 'reset';
				o.inputtitle = isDisabled ? _('Enable') : _('Disable');
				o.onclick = ui.createHandlerFn(s, network_updown, s.section, s.map);

				o = ss.taboption('general', CBIWifiFrequencyValue, '_freq', '<br />' + _('Operating frequency'));
				o.ucisection = s.section;

				if (hwtype == 'mac80211' || hwtype == 'qcawificfg80211') {
					o = ss.taboption('general', CBIWifiTxPowerValue, 'txpower', _('Maximum transmit power'), _('Specifies the maximum transmit power the wireless radio may use. Depending on regulatory requirements and wireless usage, the actual transmit power may be reduced by the driver.'));
					o.wifiNetwork = radioNet;

					o = ss.taboption('advanced', CBIWifiCountryValue, 'country', _('Country Code'));
					o.wifiNetwork = radioNet;
				}

				if (hwtype == 'qcawificfg80211' && /g$/.test(uci.get('wireless', radioNet.getWifiDeviceName(), 'hwmode') || '')) {
					o = ss.taboption('advanced', form.Flag, 'legacy_rates', _('Allow legacy 802.11b rates'));
					o.rmempty = false;
					o.default = uci.get('wireless', radioNet.getWifiDeviceName(), 'hwmode') == '11g' ? '0' : '1';
					o = ss.taboption('advanced', form.Flag, 'noscan', _('Force 40MHz mode'), _('Always use 40MHz channels even if the secondary channel overlaps. Using this option does not comply with IEEE 802.11n-2009!'));
					o.rmempty = false;
				}

				if (hwtype == 'mac80211') {
					o = ss.taboption('advanced', form.Flag, 'legacy_rates', _('Allow legacy 802.11b rates'));
					o.default = o.enabled;

					o = ss.taboption('advanced', form.Value, 'distance', _('Distance Optimization'), _('Distance to farthest network member in meters.'));
					o.datatype = 'or(range(0,114750),"auto")';
					o.placeholder = 'auto';

					o = ss.taboption('advanced', form.Value, 'frag', _('Fragmentation Threshold'));
					o.datatype = 'min(256)';
					o.placeholder = _('off');

					o = ss.taboption('advanced', form.Value, 'rts', _('RTS/CTS Threshold'));
					o.datatype = 'uinteger';
					o.placeholder = _('off');

					o = ss.taboption('advanced', form.Flag, 'noscan', _('Force 40MHz mode'), _('Always use 40MHz channels even if the secondary channel overlaps. Using this option does not comply with IEEE 802.11n-2009!'));
					o.rmempty = true;

					o = ss.taboption('advanced', form.Value, 'beacon_int', _('Beacon Interval'));
					o.datatype = 'range(15,65535)';
					o.placeholder = 100;
					o.rmempty = true;
				}


				o = s.option(form.SectionValue, '_device', form.NamedSection, radioNet.getName(), 'wifi-iface', _('Interface Configuration'));
				o.modalonly = true;

				ss = o.subsection;
				ss.tab('general', _('General Setup'));
				ss.tab('encryption', _('Wireless Security'));
				ss.tab('macfilter', _('MAC-Filter'));
				ss.tab('advanced', _('Advanced Settings'));

				o = ss.taboption('general', form.ListValue, 'mode', _('Mode'));
				o.value('ap', _('Access Point'));
				o.value('sta', _('Client'));
				if (hwtype != 'qcawificfg80211') o.value('adhoc', _('Ad-Hoc'));
				if (hwtype == 'qcawificfg80211') {
					o.value('monitor', _('Monitor'));
					o = ss.taboption('general', form.ListValue, 'mld', _('Multi-Link Operation'), _('Create an MLO network or add this radio as a link. Mode, SSID, security and network are shared by its links. Enable each link separately.'));
					o.value('', _('Standalone interface'));
					uci.sections('wireless', 'wifi-mld').forEach(function(mld) { o.value(mld['.name'], (mld.mld_ssid || mld['.name']) + ' (' + mld['.name'] + ')'); });
					o.value('_new', _('Create MLO network'));
					o.depends('mode', 'ap'); o.depends('mode', 'ap-wds'); o.depends('mode', 'sta');
					o.cfgvalue = function(id) { return uci.get('wireless', id, 'mld') || ''; };
					o.write = qca_write_mld;
					o.remove = function(id) { qca_write_mld(id, ''); };
					o.validate = function(id, value) {
						if (!value) return true;
						if (value != '_new' && (!/^mld[0-9]+$/.test(value) || uci.get('wireless', value, '.type') != 'wifi-mld')) return _('Invalid MLO group');
						var members = uci.sections('wireless', 'wifi-iface').filter(function(s) { return s.mld == value && s['.name'] != id; }),
						    radio = uci.get('wireless', id, 'device'), frequency = this.map.lookupOption('_freq', radio)[0];
						if (members.some(function(s) { return s.device == radio; })) return _('An MLO group can have only one link per radio.');
						if (members.length >= 3) return _('An MLO group can have up to three links.');
						if (!/^11be/.test(frequency ? frequency.formvalue(radio)[1] : uci.get('wireless', radio, 'hwmode')) || members.some(function(s) { return !/^11be/.test(uci.get('wireless', s.device, 'hwmode')); })) return _('MLO requires BE mode on every radio.');
						return true;
						};
					o.renderWidget = function(id, index, value) {
						var node = form.ListValue.prototype.renderWidget.apply(this, arguments);
						node.addEventListener('widget-change', L.bind(function() {
							var value = this.formvalue(id), member = uci.sections('wireless', 'wifi-iface').filter(function(s) { return s.mld == value && s['.name'] != id; })[0];
							if (!member) return;
							[ 'mode', 'ssid', 'network', 'encryption', 'cipher', '_wpa_key' ].concat(qca_shared).forEach(function(key) {
								var option = (this.map.lookupOption(key, id) || [])[0], widget = option && option.getUIElement(id);
								if (widget) {
									var value = [ 'mode', 'ssid', 'encryption', 'cipher', '_wpa_key', 'eap_type', 'r0kh', 'r1kh', 'wps_pushbutton' ].indexOf(key) >= 0 ? option.cfgvalue(member['.name']) : uci.get('wireless', member['.name'], key);
									widget.setValue(value != null ? value : option.default != null ? option.default : '');
									}
								}, this);
							this.map.checkDepends();
							}, this));
						return node;
						};
				}

				o = ss.taboption('general', form.Value, 'mesh_id', _('Mesh Id'));
				o.depends('mode', 'mesh');

				o = ss.taboption('advanced', form.Flag, 'mesh_fwding', _('Forward mesh peer traffic'));
				o.rmempty = false;
				o.default = '1';
				o.depends('mode', 'mesh');

				o = ss.taboption('advanced', form.Value, 'mesh_rssi_threshold', _('RSSI threshold for joining'), _('0 = not using RSSI threshold, 1 = do not change driver default'));
				o.rmempty = false;
				o.default = '0';
				o.datatype = 'range(-255,1)';
				o.depends('mode', 'mesh');

				o = ss.taboption('general', form.Value, 'ssid', _('<abbr title="Extended Service Set Identifier">ESSID</abbr>'));
				o.datatype = 'maxlength(32)';
				if (hwtype == 'qcawificfg80211') {
					o.rmempty = false;
					o.cfgvalue = qca_ssid;
					o.validate = function(id, value) { return qca_valid_ssid(value) || _('SSID must contain 1 to 32 bytes and no line breaks.'); };
					o.write = function(id, value) { qca_set_shared(id, 'ssid', value); };
				}
				o.depends('mode', 'ap');
				o.depends('mode', 'sta');
				o.depends('mode', 'adhoc');
				o.depends('mode', 'ahdemo');
				if (hwtype != 'qcawificfg80211') o.depends('mode', 'monitor');
				o.depends('mode', 'ap-wds');
				o.depends('mode', 'sta-wds');
				o.depends('mode', 'wds');

				o = ss.taboption('general', form.Value, 'bssid', _('<abbr title="Basic Service Set Identifier">BSSID</abbr>'));
				o.datatype = 'macaddr';
				o.depends('mode', 'adhoc');
				o.depends('mode', 'sta');
				o.depends('mode', 'sta-wds');

				o = ss.taboption('general', widgets.NetworkSelect, 'network', _('Network'), _('Choose the network(s) you want to attach to this wireless interface or fill out the <em>custom</em> field to define a new network.'));
				o.rmempty = true;
				o.multiple = true;
				o.novirtual = true;
				if (hwtype == 'qcawificfg80211') o.remove = function(id) { qca_set_shared(id, 'network', null); };
				if (hwtype == 'qcawificfg80211') {
					o.depends('mode', 'ap'); o.depends('mode', 'ap-wds'); o.depends('mode', 'sta'); o.depends('mode', 'sta-wds');
					o.validate = function(id, value) {
						var mode = this.map.lookupOption('mode', id)[0].formvalue(id), values = Array.isArray(value) ? value : String(value || '').split(/\s+/);
						return mode != 'sta' || !values.some(function(n) { return uci.get('network', n, 'type') == 'bridge'; }) || _('Use an unbridged network for Client mode, or select Client (WDS).');
						};
					}
				o.write = function(section_id, value) {
					if (hwtype == 'qcawificfg80211') {
						qca_set_shared(section_id, 'network', value);
						var ap = uci.get('wireless', section_id, 'mode') == 'ap';
						return Promise.all(L.toArray(value).map(function(name) {
							return network.getNetwork(name).then(function(net) {
								if (!net) return network.addNetwork(name, ap ? { proto: 'none', type: 'bridge' } : { proto: 'none' });
								if (ap && !net.isEmpty()) net.set('type', 'bridge');
								return net;
								});
							}));
					}
					return network.getDevice(section_id).then(L.bind(function(dev) {
						var old_networks = dev.getNetworks().reduce(function(o, v) { o[v.getName()] = v; return o }, {}),
						    new_networks = {},
						    values = L.toArray(value),
						    tasks = [];

						for (var i = 0; i < values.length; i++) {
							new_networks[values[i]] = true;

							if (old_networks[values[i]])
								continue;

							tasks.push(network.getNetwork(values[i]).then(L.bind(function(name, net) {
								return net || network.addNetwork(name, { proto: 'none' });
							}, this, values[i])).then(L.bind(function(dev, net) {
								if (net) {
									if (!net.isEmpty())
										net.set('type', 'bridge');
									net.addDevice(dev);
								}
							}, this, dev)));
						}

						for (var name in old_networks)
							if (!new_networks[name])
								tasks.push(network.getNetwork(name).then(L.bind(function(dev, net) {
									if (net)
										net.deleteDevice(dev);
								}, this, dev)));

						return Promise.all(tasks);
					}, this));
				};

				if (hwtype == 'mac80211' || hwtype == 'qcawificfg80211') {
					var mode = ss.children[0],
					    bssid = ss.children.filter(function(o) { return o.option == 'bssid'; })[0],
					    encr;

					if (hwtype == 'mac80211') {
						mode.value('mesh', '802.11s');
						mode.value('ahdemo', _('Pseudo Ad-Hoc (ahdemo)'));
						mode.value('monitor', _('Monitor'));
					}

					bssid.depends('mode', 'adhoc');
					bssid.depends('mode', 'sta');
					bssid.depends('mode', 'sta-wds');

					o = ss.taboption('macfilter', form.ListValue, 'macfilter', _('MAC-Address Filter'));
					o.depends('mode', 'ap');
					o.depends('mode', 'ap-wds');
					o.value('', _('disable'));
					o.value('allow', _('Allow listed only'));
					o.value('deny', _('Allow all except listed'));

					o = ss.taboption('macfilter', form.DynamicList, 'maclist', _('MAC-List'));
					o.datatype = 'macaddr';
					o.depends('macfilter', 'allow');
					o.depends('macfilter', 'deny');
					o.load = function(section_id) {
						return network.getHostHints().then(L.bind(function(hints) {
							hints.getMACHints().map(L.bind(function(hint) {
								this.value(hint[0], hint[1] ? '%s (%s)'.format(hint[0], hint[1]) : hint[0]);
							}, this));

							return form.DynamicList.prototype.load.apply(this, [section_id]);
						}, this));
					};

					mode.value('ap-wds', '%s (%s)'.format(_('Access Point'), _('WDS')));
					if (hwtype != 'qcawificfg80211' || !radioNet.get('mld')) mode.value('sta-wds', '%s (%s)'.format(_('Client'), _('WDS')));

					mode.write = function(section_id, value) {
						var mld = hwtype == 'qcawificfg80211' && this.map.lookupOption('mld', section_id)[0];
						switch (value) {
						case 'ap-wds':
							uci.set('wireless', section_id, 'mode', 'ap');
							uci.set('wireless', section_id, 'wds', '1');
							break;

						case 'sta-wds':
							uci.set('wireless', section_id, 'mode', 'sta');
							uci.set('wireless', section_id, 'wds', '1');
							break;

						default:
							uci.set('wireless', section_id, 'mode', value);
							uci.unset('wireless', section_id, 'wds');
								if (hwtype == 'qcawificfg80211' && value == 'monitor') {
									uci.set('wireless', section_id, 'encryption', 'none');
									uci.unset('wireless', section_id, 'sae');
									uci.unset('wireless', section_id, 'owe');
									uci.unset('wireless', section_id, 'network');
								}
							break;
						}
						if (mld && mld.isActive(section_id) && mld.formvalue(section_id) && mld.formvalue(section_id) == uci.get('wireless', section_id, 'mld')) {
							qca_set_shared(section_id, 'mode', uci.get('wireless', section_id, 'mode'));
							qca_set_shared(section_id, 'wds', uci.get('wireless', section_id, 'wds'));
							uci.set('wireless', uci.get('wireless', section_id, 'mld'), 'role', uci.get('wireless', section_id, 'mode') == 'sta' ? 'Non-AP' : 'AP');
							}
					};

					mode.cfgvalue = function(section_id) {
						var mode = uci.get('wireless', section_id, 'mode'),
						    wds = uci.get('wireless', section_id, 'wds');

						if (mode == 'ap' && wds)
							return 'ap-wds';
						else if (mode == 'sta' && wds)
							return 'sta-wds';

						return mode;
					};

					o = ss.taboption('general', form.Flag, 'hidden', _('Hide <abbr title="Extended Service Set Identifier">ESSID</abbr>'));
					o.depends('mode', 'ap');
					o.depends('mode', 'ap-wds');

					o = ss.taboption('general', form.Flag, 'wmm', _('WMM Mode'));
					o.depends('mode', 'ap');
					o.depends('mode', 'ap-wds');
					o.default = o.enabled;

					o = ss.taboption('advanced', form.Flag, 'isolate', _('Isolate Clients'), _('Prevents client-to-client communication'));
					o.depends('mode', 'ap');
					o.depends('mode', 'ap-wds');

					o = ss.taboption('advanced', hwtype == 'qcawificfg80211' ? form.DummyValue : form.Value, 'ifname', _('Interface name'), hwtype == 'qcawificfg80211' ? _('Allocated without using the interfaces reserved by the vendor.') : _('Override default interface name'));
					o.optional = true;
					o.placeholder = radioNet.getIfname();
					if (/^radio\d+\.network/.test(o.placeholder))
						o.placeholder = '';

					o = ss.taboption('advanced', form.Flag, hwtype == 'qcawificfg80211' ? 'shpreamble' : 'short_preamble', _('Short Preamble'));
					o.default = o.enabled;

					o = ss.taboption('advanced', form.Value, 'dtim_period', _('DTIM Interval'), _('Delivery Traffic Indication Message Interval'));
					o.optional = true;
					o.placeholder = 2;
					o.datatype = 'range(1,255)';

					o = ss.taboption('advanced', form.Value, 'wpa_group_rekey', _('Time interval for rekeying GTK'), _('sec'));
					o.optional    = true;
					o.placeholder = 600;
					o.datatype    = 'uinteger';

					o = ss.taboption('advanced', form.Flag , 'skip_inactivity_poll', _('Disable Inactivity Polling'));
					o.optional    = true;
					o.datatype    = 'uinteger';

					o = ss.taboption('advanced', form.Value, 'max_inactivity', _('Station inactivity limit'), _('sec'));
					o.optional    = true;
					o.placeholder = 300;
					o.datatype    = 'uinteger';

					o = ss.taboption('advanced', form.Value, 'max_listen_interval', _('Maximum allowed Listen Interval'));
					o.optional    = true;
					o.placeholder = 65535;
					o.datatype    = 'uinteger';

					o = ss.taboption('advanced', form.Flag, 'disassoc_low_ack', _('Disassociate On Low Acknowledgement'), _('Allow AP mode to disconnect STAs based on low ACK condition'));
					o.default = o.enabled;
				}


				if (hwtype == 'qcawificfg80211') {
					[ ['bintval', _('Beacon Interval'), 'range(15,65535)', 100], ['rts', _('RTS/CTS Threshold'), 'or(range(0,2347),"off")', 'off'], ['frag', _('Fragmentation Threshold'), 'range(256,2346)', 2346] ].forEach(function(p) {
						o = ss.taboption('advanced', form.Value, p[0], p[1]);
						o.datatype = p[2]; o.placeholder = p[3]; o.optional = true;
						o.depends('mode', 'ap'); o.depends('mode', 'ap-wds');
						if (p[0] == 'frag') {
							o.description = _('The native driver supports fragmentation thresholds in legacy modes only.');
							o.validate = function(id, value) {
								var radio = radioNet.getWifiDeviceName(), frequency = this.map.lookupOption('_freq', radio)[0];
								var hwmode = frequency ? frequency.formvalue(radio)[1] : uci.get('wireless', radio, 'hwmode');
								return !value || /^11[abg]$/.test(hwmode) || _('Clear the fragmentation threshold before selecting N, AC, AX or BE mode.');
								};
							}
					});
					if (radioNet.get('mld')) {
						o = ss.taboption('general', form.DummyValue, '_mld', _('Multi-Link Operation'));
						o.cfgvalue = function(id) { return radioNet.get('mld') + ': ' + qca_members(id).join(', '); };
						o.description = _('Each link can be enabled or disabled separately.');
						o.write = function() {};
					}
				}

				encr = o = ss.taboption('encryption', form.ListValue, 'encryption', _('Encryption'));
				o.depends('mode', 'ap');
				o.depends('mode', 'sta');
				o.depends('mode', 'adhoc');
				o.depends('mode', 'ahdemo');
				o.depends('mode', 'ap-wds');
				o.depends('mode', 'sta-wds');
				o.depends('mode', 'mesh');

				o.cfgvalue = function(section_id) {
					if (hwtype == 'qcawificfg80211') return qca_security(section_id);
					var v = String(uci.get('wireless', section_id, 'encryption'));
					if (v == 'wep')
						return 'wep-open';
					else if (v.match(/\+/))
						return v.replace(/\+.+$/, '');
					return v;
				};

				o.write = function(section_id, value) {
					if (hwtype == 'qcawificfg80211') {
						var e = this.section.children.filter(function(o) { return o.option == 'encryption' })[0].formvalue(section_id),
						    c = this.section.children.filter(function(o) { return o.option == 'cipher' })[0];
						qca_write_security(section_id, e);
						if (c.isActive(section_id)) {
							var v = c.formvalue(section_id);
							if ([ 'ccmp', 'ccmp-256', 'gcmp', 'gcmp-256' ].indexOf(v) < 0 || (e == 'wpa3-192' && v != 'gcmp-256')) throw new Error(_('WPA3-EAP (192-bit) requires GCMP-256.'));
							qca_set_shared(section_id, 'encryption', uci.get('wireless', section_id, 'encryption').replace(/(?:ccmp|gcmp)(?:-256)?$/, v));
						}
						return;
					}
					var e = this.section.children.filter(function(o) { return o.option == 'encryption' })[0].formvalue(section_id),
					    co = this.section.children.filter(function(o) { return o.option == 'cipher' })[0], c = co.formvalue(section_id);

					if (value == 'wpa' || value == 'wpa2' || value == 'wpa3' || value == 'wpa3-mixed')
						uci.unset('wireless', section_id, 'key');

					if (co.isActive(section_id) && e && (c == 'tkip' || c == 'ccmp' || c == 'tkip+ccmp'))
						e += '+' + c;

					uci.set('wireless', section_id, 'encryption', e);
				};

				o = ss.taboption('encryption', form.ListValue, 'cipher', _('Cipher'));
				o.depends('encryption', 'wpa');
				o.depends('encryption', 'wpa2');
				o.depends('encryption', 'wpa3');
				o.depends('encryption', 'wpa3-mixed');
				o.depends('encryption', 'psk');
				o.depends('encryption', 'psk2');
				o.depends('encryption', 'wpa-mixed');
				o.depends('encryption', 'psk-mixed');
				if (hwtype != 'qcawificfg80211') o.value('auto', _('auto'));
				o.value('ccmp', _('Force CCMP (AES)'));
				if (hwtype == 'qcawificfg80211') {
					o.value('ccmp-256', 'CCMP-256'); o.value('gcmp', 'GCMP'); o.value('gcmp-256', 'GCMP-256');
					o.depends('encryption', 'sae'); o.depends('encryption', 'sae-mixed'); o.depends('encryption', 'owe');
					o.depends('encryption', 'wpa3-192');
					o.validate = function(id, value) { return this.section.children.filter(function(o) { return o.option == 'encryption' })[0].formvalue(id) != 'wpa3-192' || value == 'gcmp-256' || _('WPA3-EAP (192-bit) requires GCMP-256.'); };
				}
				if (hwtype != 'qcawificfg80211') {
					o.value('tkip', _('Force TKIP'));
					o.value('tkip+ccmp', _('Force TKIP and CCMP (AES)'));
				}
				o.write = ss.children.filter(function(o) { return o.option == 'encryption' })[0].write;

				o.cfgvalue = function(section_id) {
					if (hwtype == 'qcawificfg80211') { var c = (uci.get('wireless', section_id, 'encryption') || '').match(/(ccmp(?:-256)?|gcmp(?:-256)?)$/); return c ? c[1] : 'ccmp'; }
					var v = String(uci.get('wireless', section_id, 'encryption'));
					if (v.match(/\+/)) {
						v = v.replace(/^[^+]+\+/, '');
						if (v == 'aes')
							v = 'ccmp';
						else if (v == 'tkip+aes' || v == 'aes+tkip' || v == 'ccmp+tkip')
							v = 'tkip+ccmp';
					}
					return v;
				};


				var crypto_modes = [];

				if (hwtype == 'mac80211') {
					var has_supplicant = L.hasSystemFeature('wpasupplicant'),
					    has_hostapd = L.hasSystemFeature('hostapd');

					// Probe EAP support
					var has_ap_eap = L.hasSystemFeature('hostapd', 'eap'),
					    has_sta_eap = L.hasSystemFeature('wpasupplicant', 'eap');

					// Probe SAE support
					var has_ap_sae = L.hasSystemFeature('hostapd', 'sae'),
					    has_sta_sae = L.hasSystemFeature('wpasupplicant', 'sae');

					// Probe OWE support
					var has_ap_owe = L.hasSystemFeature('hostapd', 'owe'),
					    has_sta_owe = L.hasSystemFeature('wpasupplicant', 'owe');

					// Probe Suite-B support
					var has_ap_eap192 = L.hasSystemFeature('hostapd', 'suiteb192'),
					    has_sta_eap192 = L.hasSystemFeature('wpasupplicant', 'suiteb192');


					if (has_hostapd || has_supplicant) {
						crypto_modes.push(['psk2',      'WPA2-PSK',                    35]);
						crypto_modes.push(['psk-mixed', 'WPA-PSK/WPA2-PSK Mixed Mode', 22]);
						crypto_modes.push(['psk',       'WPA-PSK',                     21]);
					}
					else {
						encr.description = _('WPA-Encryption requires wpa_supplicant (for client mode) or hostapd (for AP and ad-hoc mode) to be installed.');
					}

					if (has_ap_sae || has_sta_sae) {
						crypto_modes.push(['sae',       'WPA3-SAE',                     31]);
						crypto_modes.push(['sae-mixed', 'WPA2-PSK/WPA3-SAE Mixed Mode', 30]);
					}

					if (has_ap_eap || has_sta_eap) {
						if (has_ap_eap192 || has_sta_eap192) {
							crypto_modes.push(['wpa3', 'WPA3-EAP', 33]);
							crypto_modes.push(['wpa3-mixed', 'WPA2-EAP/WPA3-EAP Mixed Mode', 32]);
						}

						crypto_modes.push(['wpa2', 'WPA2-EAP', 34]);
						crypto_modes.push(['wpa',  'WPA-EAP',  20]);
					}

					if (has_ap_owe || has_sta_owe) {
						crypto_modes.push(['owe', 'OWE', 1]);
					}

					encr.crypto_support = {
						'ap': {
							'wep-open': true,
							'wep-shared': true,
							'psk': has_hostapd || _('Requires hostapd'),
							'psk2': has_hostapd || _('Requires hostapd'),
							'psk-mixed': has_hostapd || _('Requires hostapd'),
							'sae': has_ap_sae || _('Requires hostapd with SAE support'),
							'sae-mixed': has_ap_sae || _('Requires hostapd with SAE support'),
							'wpa': has_ap_eap || _('Requires hostapd with EAP support'),
							'wpa2': has_ap_eap || _('Requires hostapd with EAP support'),
							'wpa3': has_ap_eap192 || _('Requires hostapd with EAP Suite-B support'),
							'wpa3-mixed': has_ap_eap192 || _('Requires hostapd with EAP Suite-B support'),
							'owe': has_ap_owe || _('Requires hostapd with OWE support')
						},
						'sta': {
							'wep-open': true,
							'wep-shared': true,
							'psk': has_supplicant || _('Requires wpa-supplicant'),
							'psk2': has_supplicant || _('Requires wpa-supplicant'),
							'psk-mixed': has_supplicant || _('Requires wpa-supplicant'),
							'sae': has_sta_sae || _('Requires wpa-supplicant with SAE support'),
							'sae-mixed': has_sta_sae || _('Requires wpa-supplicant with SAE support'),
							'wpa': has_sta_eap || _('Requires wpa-supplicant with EAP support'),
							'wpa2': has_sta_eap || _('Requires wpa-supplicant with EAP support'),
							'wpa3': has_sta_eap192 || _('Requires wpa-supplicant with EAP Suite-B support'),
							'wpa3-mixed': has_sta_eap192 || _('Requires wpa-supplicant with EAP Suite-B support'),
							'owe': has_sta_owe || _('Requires wpa-supplicant with OWE support')
						},
						'adhoc': {
							'wep-open': true,
							'wep-shared': true,
							'psk': has_supplicant || _('Requires wpa-supplicant'),
							'psk2': has_supplicant || _('Requires wpa-supplicant'),
							'psk-mixed': has_supplicant || _('Requires wpa-supplicant'),
						},
						'mesh': {
							'sae': has_sta_sae || _('Requires wpa-supplicant with SAE support')
						},
						'ahdemo': {
							'wep-open': true,
							'wep-shared': true
						},
						'wds': {
							'wep-open': true,
							'wep-shared': true
						}
					};

					encr.crypto_support['ap-wds'] = encr.crypto_support['ap'];
					encr.crypto_support['sta-wds'] = encr.crypto_support['sta'];

					encr.validate = function(section_id, value) {
						var modeopt = this.section.children.filter(function(o) { return o.option == 'mode' })[0],
						    modeval = modeopt.formvalue(section_id),
						    modetitle = modeopt.vallist[modeopt.keylist.indexOf(modeval)],
						    enctitle = this.vallist[this.keylist.indexOf(value)];

						if (value == 'none')
							return true;

						if (!L.isObject(this.crypto_support[modeval]) || !this.crypto_support[modeval].hasOwnProperty(value))
							return _('The selected %s mode is incompatible with %s encryption').format(modetitle, enctitle);

						return this.crypto_support[modeval][value];
					};
				}
				else if (hwtype == 'broadcom') {
					crypto_modes.push(['psk2',     'WPA2-PSK',                    33]);
					crypto_modes.push(['psk+psk2', 'WPA-PSK/WPA2-PSK Mixed Mode', 22]);
					crypto_modes.push(['psk',      'WPA-PSK',                     21]);
				}

				if (hwtype == 'qcawificfg80211') {
					crypto_modes.push(['sae', 'WPA3-SAE', 35]);
					crypto_modes.push(['owe', 'OWE', 31], ['wpa3', 'WPA3-EAP', 35], ['wpa3-192', 'WPA3-EAP (192-bit)', 36]);
					encr.validate = function(id, value) {
						var mld = this.map.lookupOption('mld', id)[0];
						return (!(mld.isActive(id) && mld.formvalue(id)) && !qca_secure_band(id)) || [ 'sae', 'owe', 'wpa3', 'wpa3-192' ].indexOf(value) >= 0 || _('MLO and 6 GHz require WPA3-SAE, OWE or WPA3-EAP.');
						};
					if (!qca_secure_band(radioNet.getName())) {
							crypto_modes.push(['wpa2', 'WPA2-EAP', 34], ['wpa3-mixed', 'WPA2-EAP/WPA3-EAP Mixed Mode', 33], ['psk2', 'WPA2-PSK', 34], ['sae-mixed', 'WPA2-PSK/WPA3-SAE Mixed Mode', 33], ['none', _('No Encryption'), 0]);
					}
				}
				else {
					crypto_modes.push(['wep-open', _('WEP Open System'), 11], ['wep-shared', _('WEP Shared Key'), 10], ['none', _('No Encryption'), 0]);
				}

				crypto_modes.sort(function(a, b) { return b[2] - a[2] });

				for (var i = 0; i < crypto_modes.length; i++) {
					var security_level = (crypto_modes[i][2] >= 30) ? _('strong security')
						: (crypto_modes[i][2] >= 20) ? _('medium security')
							: (crypto_modes[i][2] >= 10) ? _('weak security') : _('open network');

					encr.value(crypto_modes[i][0], '%s (%s)'.format(crypto_modes[i][1], security_level));
				}


				o = ss.taboption('encryption', form.Value, 'auth_server', _('Radius-Authentication-Server'));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.datatype = 'host(0)';

				o = ss.taboption('encryption', form.Value, 'auth_port', _('Radius-Authentication-Port'), _('Default %d').format(1812));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.datatype = 'port';

				o = ss.taboption('encryption', form.Value, 'auth_secret', _('Radius-Authentication-Secret'));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.password = true;

				o = ss.taboption('encryption', form.Value, 'acct_server', _('Radius-Accounting-Server'));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.datatype = 'host(0)';

				o = ss.taboption('encryption', form.Value, 'acct_port', _('Radius-Accounting-Port'), _('Default %d').format(1813));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.datatype = 'port';

				o = ss.taboption('encryption', form.Value, 'acct_secret', _('Radius-Accounting-Secret'));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.password = true;

				o = ss.taboption('encryption', form.Value, 'dae_client', _('DAE-Client'));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.datatype = 'host(0)';

				o = ss.taboption('encryption', form.Value, 'dae_port', _('DAE-Port'), _('Default %d').format(3799));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.datatype = 'port';

				o = ss.taboption('encryption', form.Value, 'dae_secret', _('DAE-Secret'));
				add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
				o.rmempty = true;
				o.password = true;


				o = ss.taboption('encryption', form.Value, '_wpa_key', _('Key'));
				o.depends('encryption', 'psk');
				o.depends('encryption', 'psk2');
				o.depends('encryption', 'psk+psk2');
				o.depends('encryption', 'psk-mixed');
				o.depends('encryption', 'sae');
				o.depends('encryption', 'sae-mixed');
				o.datatype = 'wpakey';
				if (hwtype == 'qcawificfg80211') {
					o.validate = function(id, value) {
						var mode = this.section.children.filter(function(o) { return o.option == 'encryption' })[0].formvalue(id);
						return qca_valid_key(value, mode) || _('Use an 8 to 63 byte password without line breaks. A 64 digit hexadecimal key is supported only for WPA2. SAE passwords cannot contain |.');
					};
				}
				o.rmempty = hwtype != 'qcawificfg80211';
				o.password = true;

				o.cfgvalue = function(section_id) {
					var key = uci.get('wireless', section_id, 'key');
					return /^[1234]$/.test(key) ? null : key;
				};

				o.write = function(section_id, value) {
					if (hwtype == 'qcawificfg80211') { qca_write_key(section_id, value); return; }
					uci.set('wireless', section_id, 'key', value);
					uci.unset('wireless', section_id, 'key1');
					uci.unset('wireless', section_id, 'key2');
					uci.unset('wireless', section_id, 'key3');
					uci.unset('wireless', section_id, 'key4');
				};


				o = ss.taboption('encryption', form.ListValue, '_wep_key', _('Used Key Slot'));
				o.depends('encryption', 'wep-open');
				o.depends('encryption', 'wep-shared');
				o.value('1', _('Key #%d').format(1));
				o.value('2', _('Key #%d').format(2));
				o.value('3', _('Key #%d').format(3));
				o.value('4', _('Key #%d').format(4));

				o.cfgvalue = function(section_id) {
					var slot = +uci.get('wireless', section_id, 'key');
					return (slot >= 1 && slot <= 4) ? String(slot) : '';
				};

				o.write = function(section_id, value) {
					uci.set('wireless', section_id, 'key', value);
				};

				for (var slot = 1; slot <= 4; slot++) {
					o = ss.taboption('encryption', form.Value, 'key%d'.format(slot), _('Key #%d').format(slot));
					o.depends('encryption', 'wep-open');
					o.depends('encryption', 'wep-shared');
					o.datatype = 'wepkey';
					o.rmempty = true;
					o.password = true;

					o.write = function(section_id, value) {
						if (value != null && (value.length == 5 || value.length == 13))
							value = 's:%s'.format(value);
						uci.set('wireless', section_id, this.option, value);
					};
				}


				if (hwtype == 'mac80211' || hwtype == 'qcawificfg80211') {
					// Probe 802.11r support (and EAP support as a proxy for Openwrt)
					var has_80211r = hwtype == 'qcawificfg80211' || L.hasSystemFeature('hostapd', '11r') || L.hasSystemFeature('hostapd', 'eap');

					o = ss.taboption('encryption', form.Flag, 'ieee80211r', _('802.11r Fast Transition'), _('Enables fast roaming among access points that belong to the same Mobility Domain'));
					add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
					if (has_80211r)
						add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['psk', 'psk2', 'psk-mixed', 'sae', 'sae-mixed'] });
					o.rmempty = true;

					o = ss.taboption('encryption', form.Value, 'nasid', _('NAS ID'), _('Used for two different purposes: RADIUS NAS ID and 802.11r R0KH-ID. Not needed with normal WPA(2)-PSK.'));
					add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });
					o.depends({ ieee80211r: '1' });
					o.rmempty = true;

					o = ss.taboption('encryption', form.Value, 'mobility_domain', _('Mobility Domain'), _('4-character hexadecimal ID'));
					o.depends({ ieee80211r: '1' });
					o.placeholder = '4f57';
					o.datatype = 'and(hexstring,length(4))';
					o.rmempty = true;

					o = ss.taboption('encryption', form.Value, 'reassociation_deadline', _('Reassociation Deadline'), _('time units (TUs / 1.024 ms) [1000-65535]'));
					o.depends({ ieee80211r: '1' });
					o.placeholder = '1000';
					o.datatype = 'range(1000,65535)';
					o.rmempty = true;

					o = ss.taboption('encryption', form.ListValue, 'ft_over_ds', _('FT protocol'));
					o.depends({ ieee80211r: '1' });
					o.value('1', _('FT over DS'));
					o.value('0', _('FT over the Air'));
					o.rmempty = true;

					o = ss.taboption('encryption', form.Flag, 'ft_psk_generate_local', _('Generate PMK locally'), _('When using a PSK, the PMK can be automatically generated. When enabled, the R0/R1 key options below are not applied. Disable this to use the R0 and R1 key options.'));
					o.depends({ ieee80211r: '1' });
					o.default = o.enabled;
					o.rmempty = false;

					o = ss.taboption('encryption', form.Value, 'r0_key_lifetime', _('R0 Key Lifetime'), _('minutes'));
					o.depends({ ieee80211r: '1' });
					o.placeholder = '10000';
					o.datatype = 'uinteger';
					o.rmempty = true;

					o = ss.taboption('encryption', form.Value, 'r1_key_holder', _('R1 Key Holder'), _('6-octet identifier as a hex string - no colons'));
					o.depends({ ieee80211r: '1' });
					o.placeholder = '00004f577274';
					o.datatype = 'and(hexstring,length(12))';
					o.rmempty = true;

					o = ss.taboption('encryption', form.Flag, 'pmk_r1_push', _('PMK R1 Push'));
					o.depends({ ieee80211r: '1' });
					o.placeholder = '0';
					o.rmempty = true;

					o = ss.taboption('encryption', form.DynamicList, 'r0kh', _('External R0 Key Holder List'), _('List of R0KHs in the same Mobility Domain. <br />Format: MAC-address,NAS-Identifier,128-bit key as hex string. <br />This list is used to map R0KH-ID (NAS Identifier) to a destination MAC address when requesting PMK-R1 key from the R0KH that the STA used during the Initial Mobility Domain Association.'));
					o.depends({ ieee80211r: '1' });
					o.rmempty = true;

					o = ss.taboption('encryption', form.DynamicList, 'r1kh', _('External R1 Key Holder List'), _ ('List of R1KHs in the same Mobility Domain. <br />Format: MAC-address,R1KH-ID as 6 octets with colons,128-bit key as hex string. <br />This list is used to map R1KH-ID to a destination MAC address when sending PMK-R1 key from the R0KH. This is also the list of authorized R1KHs in the MD that can request PMK-R1 keys.'));
					o.depends({ ieee80211r: '1' });
					o.rmempty = true;
					// End of 802.11r options

					o = ss.taboption('encryption', form.ListValue, 'eap_type', _('EAP-Method'));
					o.value('tls',  'TLS');
					o.value('ttls', 'TTLS');
					o.value('peap', 'PEAP');
					if (hwtype != 'qcawificfg80211') o.value('fast', 'FAST');
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });


					o = ss.taboption('encryption', form.FileUpload, 'ca_cert', _('Path to CA-Certificate'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });

					o = ss.taboption('encryption', form.Value, 'subject_match', _('Certificate constraint (Subject)'), _("Certificate constraint substring - e.g. /CN=wifi.mycompany.com<br />See `logread -f` during handshake for actual values"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });

					o = ss.taboption('encryption', form.DynamicList, 'altsubject_match', _('Certificate constraint (SAN)'), _("Certificate constraint(s) via Subject Alternate Name values<br />(supported attributes: EMAIL, DNS, URI) - e.g. DNS:wifi.mycompany.com"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });

					o = ss.taboption('encryption', form.DynamicList, 'domain_match', _('Certificate constraint (Domain)'), _("Certificate constraint(s) against DNS SAN values (if available)<br />or Subject CN (exact match)"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });

					o = ss.taboption('encryption', form.DynamicList, 'domain_suffix_match', _('Certificate constraint (Wildcard)'), _("Certificate constraint(s) against DNS SAN values (if available)<br />or Subject CN (suffix match)"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'] });

					o = ss.taboption('encryption', form.FileUpload, 'client_cert', _('Path to Client-Certificate'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], eap_type: ['tls'] });

					o = ss.taboption('encryption', form.FileUpload, 'priv_key', _('Path to Private Key'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], eap_type: ['tls'] });

					o = ss.taboption('encryption', form.Value, 'priv_key_pwd', _('Password of Private Key'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], eap_type: ['tls'] });
					o.password = true;

					o = ss.taboption('encryption', form.ListValue, 'auth', _('Authentication'));
					o.value('PAP', 'PAP');
					o.value('CHAP', 'CHAP');
					o.value('MSCHAP', 'MSCHAP');
					o.value('MSCHAPV2', 'MSCHAPv2');
					o.value('EAP-GTC', 'EAP-GTC');
					o.value('EAP-MD5', 'EAP-MD5');
					o.value('EAP-MSCHAPV2', 'EAP-MSCHAPv2');
					o.value('EAP-TLS', 'EAP-TLS');
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], eap_type: ['fast', 'peap', 'ttls'] });

					o.validate = function(section_id, value) {
						var eo = this.section.children.filter(function(o) { return o.option == 'eap_type' })[0],
						    ev = eo.formvalue(section_id);

						if (ev != 'ttls' && (value == 'PAP' || value == 'CHAP' || value == 'MSCHAP' || value == 'MSCHAPV2'))
							return _('This authentication type is not applicable to the selected EAP method.');

						return true;
					};

					o = ss.taboption('encryption', form.FileUpload, 'ca_cert2', _('Path to inner CA-Certificate'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });

					o = ss.taboption('encryption', form.Value, 'subject_match2', _('Inner certificate constraint (Subject)'), _("Certificate constraint substring - e.g. /CN=wifi.mycompany.com<br />See `logread -f` during handshake for actual values"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });

					o = ss.taboption('encryption', form.DynamicList, 'altsubject_match2', _('Inner certificate constraint (SAN)'), _("Certificate constraint(s) via Subject Alternate Name values<br />(supported attributes: EMAIL, DNS, URI) - e.g. DNS:wifi.mycompany.com"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });

					o = ss.taboption('encryption', form.DynamicList, 'domain_match2', _('Inner certificate constraint (Domain)'), _("Certificate constraint(s) against DNS SAN values (if available)<br />or Subject CN (exact match)"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });

					o = ss.taboption('encryption', form.DynamicList, 'domain_suffix_match2', _('Inner certificate constraint (Wildcard)'), _("Certificate constraint(s) against DNS SAN values (if available)<br />or Subject CN (suffix match)"));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });

					o = ss.taboption('encryption', form.FileUpload, 'client_cert2', _('Path to inner Client-Certificate'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });

					o = ss.taboption('encryption', form.FileUpload, 'priv_key2', _('Path to inner Private Key'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });

					o = ss.taboption('encryption', form.Value, 'priv_key2_pwd', _('Password of inner Private Key'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], auth: ['EAP-TLS'] });
					o.password = true;

					o = ss.taboption('encryption', form.Value, 'identity', _('Identity'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], eap_type: ['fast', 'peap', 'tls', 'ttls'] });

					o = ss.taboption('encryption', form.Value, 'anonymous_identity', _('Anonymous Identity'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], eap_type: ['fast', 'peap', 'tls', 'ttls'] });

					o = ss.taboption('encryption', form.Value, 'password', _('Password'));
					add_dependency_permutations(o, { mode: ['sta', 'sta-wds'], encryption: ['wpa', 'wpa2', 'wpa3', 'wpa3-mixed'], eap_type: ['fast', 'peap', 'ttls'] });
					o.password = true;


					if (hwtype == 'mac80211' || hwtype == 'qcawificfg80211') {
						// ieee802.11w options
						if (hwtype == 'qcawificfg80211' || L.hasSystemFeature('hostapd', '11w')) {
							o = ss.taboption('encryption', form.ListValue, 'ieee80211w', _('802.11w Management Frame Protection'), _("Requires the 'full' version of wpad/hostapd and support from the wifi driver <br />(as of Jan 2019: ath9k, ath10k, mwlwifi and mt76)"));
							o.value(hwtype == 'qcawificfg80211' ? '0' : '', _('Disabled'));
							if (hwtype == 'qcawificfg80211') {
								o.default = '0';
								o.rmempty = false;
								o.validate = function(id, value) {
									var e = this.section.children.filter(function(o) { return o.option == 'encryption' })[0].formvalue(id);
									return [ 'sae', 'owe', 'wpa3', 'wpa3-192' ].indexOf(e) < 0 || value == '2' || _('This encryption mode requires management frame protection.');
								};
							}
							o.value('1', _('Optional'));
							o.value('2', _('Required'));
							add_dependency_permutations(o, { mode: ['ap', 'ap-wds', 'sta', 'sta-wds'], encryption: ['owe', 'psk2', 'psk-mixed', 'sae', 'sae-mixed', 'wpa2', 'wpa3', 'wpa3-mixed'] });

							o.defaults = {
								'2': [{ encryption: 'wpa3-192' }, { encryption: 'sae' }, { encryption: 'owe' }, { encryption: 'wpa3' }, { encryption: 'wpa3-mixed' }],
								'1': [{ encryption: 'sae-mixed'}],
								'':  []
							};

							o = ss.taboption('encryption', form.Value, 'ieee80211w_max_timeout', _('802.11w maximum timeout'), _('802.11w Association SA Query maximum timeout'));
							o.depends('ieee80211w', '1');
							o.depends('ieee80211w', '2');
							o.datatype = 'uinteger';
							o.placeholder = '1000';
							o.rmempty = true;

							o = ss.taboption('encryption', form.Value, 'ieee80211w_retry_timeout', _('802.11w retry timeout'), _('802.11w Association SA Query retry timeout'));
							o.depends('ieee80211w', '1');
							o.depends('ieee80211w', '2');
							o.datatype = 'uinteger';
							o.placeholder = '201';
							o.rmempty = true;
						};

						o = ss.taboption('encryption', form.Flag, 'wpa_disable_eapol_key_retries', _('Enable key reinstallation (KRACK) countermeasures'), _('Complicates key reinstallation attacks on the client side by disabling retransmission of EAPOL-Key frames that are used to install keys. This workaround might cause interoperability issues and reduced robustness of key negotiation especially in environments with heavy traffic load.'));
						add_dependency_permutations(o, { mode: ['ap', 'ap-wds'], encryption: ['psk2', 'psk-mixed', 'sae', 'sae-mixed', 'wpa2', 'wpa3', 'wpa3-mixed'] });

						if (hwtype == 'qcawificfg80211' || (L.hasSystemFeature('hostapd', 'cli') && L.hasSystemFeature('wpasupplicant'))) {
							o = ss.taboption('encryption', form.Flag, 'wps_pushbutton', _('Enable WPS pushbutton, requires WPA(2)-PSK/WPA3-SAE'))
							o.enabled = '1';
							o.disabled = '0';
							o.default = o.disabled;
							o.depends('encryption', 'psk');
							o.depends('encryption', 'psk2');
							o.depends('encryption', 'psk-mixed');
							o.depends('encryption', 'sae');
							o.depends('encryption', 'sae-mixed');
						}
					}
				}

				if (hwtype == 'qcawificfg80211') {

					ss.children.forEach(function(o) {
						(o.deps || []).filter(function(d) { return d.encryption == 'wpa3'; }).forEach(function(d) { o.depends(Object.assign({}, d, { encryption: 'wpa3-192' })); });
						if (qca_shared.indexOf(o.option) < 0) return;
						var key = o.option == 'wps_pushbutton' ? 'wps_pbc' : o.option;
						o.write = function(id, value) {
							if (/[\r\n\0]/.test(value)) throw new Error(_('Line breaks are not allowed.'));
							if (key == 'r0kh' || key == 'r1kh') value = L.toArray(value).map(function(v) { return v.replace(/,/g, ' '); });
							if (key == 'eap_type') value = value.toUpperCase();
							qca_set_shared(id, key, value);
							if (key == 'wps_pbc') qca_set_shared(id, 'wps', value);
						};
						o.remove = function(id) { qca_set_shared(id, key, null); if (key == 'wps_pbc') qca_set_shared(id, 'wps', '0'); };
						if (key != o.option || key == 'r0kh' || key == 'r1kh' || key == 'eap_type')
							o.cfgvalue = function(id) { var v = uci.get('wireless', id, key); return key == 'eap_type' ? (v || '').toLowerCase() : key == 'r0kh' || key == 'r1kh' ? L.toArray(v).map(function(s) { return s.trim().replace(/\s+/g, ','); }) : v; };
					});
				}
			});
		};

		s.handleRemove = function(section_id, ev) {
			document.querySelector('.cbi-section-table-row[data-sid="%s"]'.format(section_id)).style.opacity = 0.5;
			if (uci.get('wireless', uci.get('wireless', section_id, 'device'), 'type') == 'qcawificfg80211') {
				qca_remove_network(section_id);
				return this.map.save(null, true);
			}
			return form.TypedSection.prototype.handleRemove.apply(this, [section_id, ev]);
		};

		// Keep the new section cancellable when modal validation fails.
		s.handleModalSave = function(modalMap, ev) {
			return modalMap.save(null, true).then(L.bind(this.map.load, this.map))
				.then(L.bind(this.map.reset, this.map)).then(L.bind(function() {
					this.addedSection = null;
					ui.hideModal();
				}, this)).catch(function(e) { ui.addNotification(null, E('p', e.message)); });
		};

		s.handleScan = function(radioDev, ev) {
			var table = E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th col-2 middle center' }, _('Signal')),
					E('div', { 'class': 'th col-4 middle left' }, _('SSID')),
					E('div', { 'class': 'th col-2 middle center hide-xs' }, _('Channel')),
					E('div', { 'class': 'th col-2 middle left hide-xs' }, _('Mode')),
					E('div', { 'class': 'th col-3 middle left hide-xs' }, _('BSSID')),
					E('div', { 'class': 'th col-3 middle left' }, _('Encryption')),
					E('div', { 'class': 'th cbi-section-actions right' }, ' '),
				])
			]);

			var stop = E('button', {
				'class': 'btn',
				'click': L.bind(this.handleScanStartStop, this),
				'style': 'display:none',
				'data-state': 'stop'
			}, _('Stop refresh'));

			cbi_update_table(table, [], E('em', { class: 'spinning' }, _('Starting wireless scan...')));

			var md = ui.showModal(radioDev.get('type') == 'qcawificfg80211' ? _('Wireless Scan') : _('Join Network: Wireless Scan'), [
				table,
				E('div', { 'class': 'right' }, [
					stop,
					' ',
					E('button', {
						'class': 'btn',
						'click': L.bind(this.handleScanAbort, this)
					}, _('Dismiss'))
				])
			]);

			md.style.maxWidth = '90%';
			md.style.maxHeight = 'none';

			this.pollFn = L.bind(this.handleScanRefresh, this, radioDev, {}, table, stop);

			poll.add(this.pollFn);
			poll.start();
		};

		s.handleScanRefresh = function(radioDev, scanCache, table, stop) {
			return radioDev.getScanList().then(L.bind(function(results) {
				var rows = [];

				for (var i = 0; i < results.length; i++)
					scanCache[results[i].bssid] = results[i];

				for (var k in scanCache)
					if (scanCache[k].stale)
						results.push(scanCache[k]);

				results.sort(function(a, b) {
					var diff = (b.quality - a.quality) || (a.channel - b.channel);

					if (diff)
						return diff;

					if (a.ssid < b.ssid)
						return -1;
					else if (a.ssid > b.ssid)
						return 1;

					if (a.bssid < b.bssid)
						return -1;
					else if (a.bssid > b.bssid)
						return 1;
				});

				for (var i = 0; i < results.length; i++) {
					var res = results[i],
					    qv = res.quality || 0,
					    qm = res.quality_max || 0,
					    q = (qv > 0 && qm > 0) ? Math.floor((100 / qm) * qv) : 0,
					    s = res.stale ? 'opacity:0.5' : '';

					rows.push([
						E('span', { 'style': s }, render_signal_badge(q, res.signal, res.noise)),
						E('span', { 'style': s }, (res.ssid != null) ? '%h'.format(res.ssid) : E('em', _('hidden'))),
						E('span', { 'style': s }, '%d'.format(res.channel)),
						E('span', { 'style': s }, '%h'.format(res.mode)),
						E('span', { 'style': s }, '%h'.format(res.bssid)),
						E('span', { 'style': s }, '%h'.format(network.formatWifiEncryption(res.encryption))),
						(radioDev.get('type') == 'qcawificfg80211' && res.mode != 'Master') ? '' : E('div', { 'class': 'right' }, E('button', {
							'class': 'cbi-button cbi-button-action important',
							'click': L.bind(this.handleJoin, this, radioDev, res)
						}, _('Join Network')))
					]);

					res.stale = true;
				}

				cbi_update_table(table, rows);

				stop.disabled = false;
				stop.style.display = '';
				stop.classList.remove('spinning');
			}, this)).catch(L.bind(function(e) {
				if (this.pollFn) poll.remove(this.pollFn);
				cbi_update_table(table, [], E('em', e.message));
				stop.style.display = '';
				stop.firstChild.data = _('Start refresh');
				stop.setAttribute('data-state', 'start');
				stop.disabled = false;
				stop.classList.remove('spinning');
			}, this));
		};

		s.handleScanStartStop = function(ev) {
			var btn = ev.currentTarget;

			if (btn.getAttribute('data-state') == 'stop') {
				poll.remove(this.pollFn);
				btn.firstChild.data = _('Start refresh');
				btn.setAttribute('data-state', 'start');
			}
			else {
				poll.add(this.pollFn);
				btn.firstChild.data = _('Stop refresh');
				btn.setAttribute('data-state', 'stop');
				btn.classList.add('spinning');
				btn.disabled = true;
			}
		};

		s.handleScanAbort = function(ev) {
			var md = dom.parent(ev.target, 'div[aria-modal="true"]');
			if (md) {
				md.style.maxWidth = '';
				md.style.maxHeight = '';
			}

			ui.hideModal();
			poll.remove(this.pollFn);

			this.pollFn = null;
		};

		s.handleJoinConfirm = function(radioDev, bss, form, ev) {
			var nameopt = L.toArray(form.lookupOption('name', '_new_'))[0],
			    passopt = L.toArray(form.lookupOption('password', '_new_'))[0],
			    bssidopt = L.toArray(form.lookupOption('bssid', '_new_'))[0],
			    zoneopt = L.toArray(form.lookupOption('zone', '_new_'))[0],
			    replopt = L.toArray(form.lookupOption('replace', '_new_'))[0],
			    nameval = (nameopt && nameopt.isValid('_new_')) ? nameopt.formvalue('_new_') : null,
			    passval = (passopt && passopt.isValid('_new_')) ? passopt.formvalue('_new_') : null,
			    bssidval = (bssidopt && bssidopt.isValid('_new_')) ? bssidopt.formvalue('_new_') : null,
			    zoneval = zoneopt ? zoneopt.formvalue('_new_') : null,
			    enc = L.isObject(bss.encryption) ? bss.encryption : null,
			    is_wep = (enc && Array.isArray(enc.wep)),
			    is_psk = (enc && Array.isArray(enc.wpa) && L.toArray(enc.authentication).some(function(a) { return a == 'psk' })),
			    is_sae = (enc && Array.isArray(enc.wpa) && L.toArray(enc.authentication).some(function(a) { return a == 'sae' })),
			    is_owe = enc && L.toArray(enc.authentication).indexOf('owe') >= 0,
			    is_eap = enc && L.toArray(enc.authentication).indexOf('802.1x') >= 0;

			if (nameval == null || (passopt && passval == null))
				return;

			var section_id = null;

			return this.map.save(function() {
				var wifi_sections = uci.sections('wireless', 'wifi-iface');

				if (replopt.formvalue('_new_') == '1') {
					for (var i = 0; i < wifi_sections.length; i++)
						if (wifi_sections[i].device == radioDev.getName())
							if (radioDev.get('type') == 'qcawificfg80211') qca_remove_network(wifi_sections[i]['.name']);
							else uci.remove('wireless', wifi_sections[i]['.name']);
				}

				if (uci.get('wireless', radioDev.getName(), 'disabled') == '1') {
					for (var i = 0; i < wifi_sections.length; i++)
						if (wifi_sections[i].device == radioDev.getName())
							uci.set('wireless', wifi_sections[i]['.name'], 'disabled', '1');

					uci.unset('wireless', radioDev.getName(), 'disabled');
				}

				section_id = next_free_sid(wifi_sections.length);

				uci.add('wireless', 'wifi-iface', section_id);
				uci.set('wireless', section_id, 'device', radioDev.getName());
				uci.set('wireless', section_id, 'mode', (bss.mode == 'Ad-Hoc') ? 'adhoc' : 'sta');
				uci.set('wireless', section_id, 'network', nameval);

				if (bss.ssid != null) {
					uci.set('wireless', section_id, 'ssid', bss.ssid);

					if (bssidval == '1')
						uci.set('wireless', section_id, 'bssid', bss.bssid);
				}
				else if (bss.bssid != null) {
					uci.set('wireless', section_id, 'bssid', bss.bssid);
				}

				if (is_sae) {
					uci.set('wireless', section_id, 'encryption', 'sae');
					uci.set('wireless', section_id, 'key', passval);
				}
				else if (is_psk) {
					for (var i = enc.wpa.length - 1; i >= 0; i--) {
						if (enc.wpa[i] == 2) {
							uci.set('wireless', section_id, 'encryption', 'psk2');
							break;
						}
						else if (enc.wpa[i] == 1) {
							uci.set('wireless', section_id, 'encryption', 'psk');
							break;
						}
					}

					uci.set('wireless', section_id, 'key', passval);
				}
				else if (is_wep) {
					uci.set('wireless', section_id, 'encryption', 'wep-open');
					uci.set('wireless', section_id, 'key', '1');
					uci.set('wireless', section_id, 'key1', passval);
				}
				else {
					uci.set('wireless', section_id, 'encryption', 'none');
				}
				if (radioDev.get('type') == 'qcawificfg80211') {
					uci.set('wireless', section_id, 'ifname', qca_next_ifname(radioDev));
					if (is_wep || (is_psk && !is_sae && enc.wpa.indexOf(2) < 0)) throw new Error(_('This driver does not support the scanned encryption mode.'));
					qca_write_security(section_id, is_sae ? 'sae' : is_psk ? 'psk2' : is_owe ? 'owe' : is_eap ? qca_secure_band(section_id) ? 'wpa3' : 'wpa2' : 'none');
					if (is_sae || is_psk) qca_write_key(section_id, passval);
					uci.set('wireless', radioDev.getName(), 'channel', String(bss.channel));
				}

				return network.addNetwork(nameval, { proto: 'dhcp' }).then(function(net) {
					firewall.deleteNetwork(net.getName());

					var zonePromise = zoneval
						? firewall.getZone(zoneval).then(function(zone) { return zone || firewall.addZone(zoneval) })
						: Promise.resolve();

					return zonePromise.then(function(zone) {
						if (zone)
							zone.addNetwork(net.getName());
					});
				});
			}).then(L.bind(function() {
				return this.renderMoreOptionsModal(section_id);
			}, this));
		};

		s.handleJoin = function(radioDev, bss, ev) {
			this.handleScanAbort(ev);

			var m2 = new form.Map('wireless'),
			    s2 = m2.section(form.NamedSection, '_new_'),
			    enc = L.isObject(bss.encryption) ? bss.encryption : null,
			    is_wep = (enc && Array.isArray(enc.wep)),
			    is_psk = (enc && Array.isArray(enc.wpa) && L.toArray(enc.authentication).some(function(a) { return a == 'psk' || a == 'sae' })),
			    replace, passphrase, name, bssid, zone;

			var nameUsed = function(name) {
				var s = uci.get('network', name);
				if (s != null && s['.type'] != 'interface')
					return true;

				var net = (s != null) ? network.instantiateNetwork(name) : null;
				return (net != null && !net.isEmpty());
			};

			s2.render = function() {
				return Promise.all([
					{},
					this.renderUCISection('_new_')
				]).then(this.renderContents.bind(this));
			};

			replace = s2.option(form.Flag, 'replace', _('Replace wireless configuration'), _('Check this option to delete the existing networks from this radio.'));

			name = s2.option(form.Value, 'name', _('Name of the new network'), _('The allowed characters are: <code>A-Z</code>, <code>a-z</code>, <code>0-9</code> and <code>_</code>'));
			name.datatype = 'uciname';
			name.default = 'wwan';
			name.rmempty = false;
			name.validate = function(section_id, value) {
				if (nameUsed(value))
					return _('The network name is already used');

				return true;
			};

			for (var i = 2; nameUsed(name.default); i++)
				name.default = 'wwan%d'.format(i);

			if (is_wep || is_psk) {
				passphrase = s2.option(form.Value, 'password', is_wep ? _('WEP passphrase') : _('WPA passphrase'), _('Specify the secret encryption key here.'));
				passphrase.datatype = is_wep ? 'wepkey' : 'wpakey';
				passphrase.password = true;
				passphrase.rmempty = false;
			}

			if (bss.ssid != null) {
				bssid = s2.option(form.Flag, 'bssid', _('Lock to BSSID'), _('Instead of joining any network with a matching SSID, only connect to the BSSID <code>%h</code>.').format(bss.bssid));
				bssid.default = '0';
			}

			zone = s2.option(widgets.ZoneSelect, 'zone', _('Create / Assign firewall-zone'), _('Choose the firewall zone you want to assign to this interface. Select <em>unspecified</em> to remove the interface from the associated zone or fill out the <em>custom</em> field to define a new zone and attach the interface to it.'));
			zone.default = 'wan';

			return m2.render().then(L.bind(function(nodes) {
				ui.showModal(_('Joining Network: %q').replace(/%q/, '"%h"'.format(bss.ssid)), [
					nodes,
					E('div', { 'class': 'right' }, [
						E('button', {
							'class': 'btn',
							'click': ui.hideModal
						}, _('Cancel')), ' ',
						E('button', {
							'class': 'cbi-button cbi-button-positive important',
							'click': ui.createHandlerFn(this, 'handleJoinConfirm', radioDev, bss, m2)
						}, _('Submit'))
					])
				], 'cbi-modal').querySelector('[id="%s"] input[class][type]'.format((passphrase || name).cbid('_new_'))).focus();
			}, this));
		};

		s.handleAdd = function(radioDev, ev) {
			var section_id = next_free_sid(uci.sections('wireless', 'wifi-iface').length);

			if (radioDev.get('type') != 'qcawificfg80211')
				uci.unset('wireless', radioDev.getName(), 'disabled');

			uci.add('wireless', 'wifi-iface', section_id);
			uci.set('wireless', section_id, 'device', radioDev.getName());
			uci.set('wireless', section_id, 'mode', 'ap');
			uci.set('wireless', section_id, 'ssid', 'OpenWrt');
			uci.set('wireless', section_id, 'encryption', 'none');
			if (radioDev.get('type') == 'qcawificfg80211') {
				uci.set('wireless', section_id, 'ifname', qca_next_ifname(radioDev));
				uci.set('wireless', section_id, 'disabled', '1');
				uci.set('wireless', section_id, 'network', [ 'lan' ]);
				if (qca_mlo(section_id) || qca_secure_band(section_id)) qca_write_security(section_id, 'sae');
			}

			this.addedSection = section_id;
			return this.renderMoreOptionsModal(section_id);
		};

		o = s.option(form.DummyValue, '_badge');
		o.modalonly = false;
		o.textvalue = function(section_id) {
			var inst = this.section.lookupRadioOrNetwork(section_id),
			    node = E('div', { 'class': 'center' });

			if (inst.getWifiNetworks)
				node.appendChild(render_radio_badge(inst));
			else
				node.appendChild(render_network_badge(inst));

			return node;
		};

		o = s.option(form.DummyValue, '_stat');
		o.modalonly = false;
		o.textvalue = function(section_id) {
			var inst = this.section.lookupRadioOrNetwork(section_id);

			if (inst.getWifiNetworks)
				return render_radio_status(inst, this.section.wifis.filter(function(e) {
					return (e.getWifiDeviceName() == inst.getName());
				}));
			else
				return render_network_status(inst);
		};

		return m.render().then(L.bind(function(m, nodes) {
			poll.add(L.bind(function() {
				var section_ids = m.children[0].cfgsections(),
				    tasks = [ network.getHostHints(), network.getWifiDevices() ];

				for (var i = 0; i < section_ids.length; i++) {
					var row = nodes.querySelector('.cbi-section-table-row[data-sid="%s"]'.format(section_ids[i])),
					    dsc = row.querySelector('[data-name="_stat"]'),
					    btns = row.querySelectorAll('.cbi-section-actions button');

					if (dsc.getAttribute('restart') == '') {
						dsc.setAttribute('restart', '1');
						var restart = fs.exec('/sbin/wifi', [uci.get('wireless', section_ids[i], 'type') == 'qcawificfg80211' ? 'reload' : 'up', section_ids[i]]);
						tasks.push(restart.catch(function(e) {
							ui.addNotification(null, E('p', e.message));
						}));
					}
					else if (dsc.getAttribute('restart') == '1') {
						dsc.removeAttribute('restart');
						btns[0].classList.remove('spinning');
						btns[0].disabled = false;
					}
				}

				return Promise.all(tasks)
					.then(L.bind(function(hosts_radios) {
						var tasks = [];

						for (var i = 0; i < hosts_radios[1].length; i++)
							tasks.push(hosts_radios[1][i].getWifiNetworks());

						return Promise.all(tasks).then(function(data) {
							hosts_radios[2] = [];

							for (var i = 0; i < data.length; i++)
								hosts_radios[2].push.apply(hosts_radios[2], data[i]);

							return hosts_radios;
						});
					}, network))
					.then(L.bind(function(hosts_radios_wifis) {
						var tasks = [];

						for (var i = 0; i < hosts_radios_wifis[2].length; i++)
							tasks.push(hosts_radios_wifis[2][i].getAssocList());

						return Promise.all(tasks).then(function(data) {
							hosts_radios_wifis[3] = [];

							for (var i = 0; i < data.length; i++) {
								var wifiNetwork = hosts_radios_wifis[2][i],
								    radioDev = hosts_radios_wifis[1].filter(function(d) { return d.getName() == wifiNetwork.getWifiDeviceName() })[0];

								for (var j = 0; j < data[i].length; j++)
									hosts_radios_wifis[3].push(Object.assign({ radio: radioDev, network: wifiNetwork }, data[i][j]));
							}

							return hosts_radios_wifis;
						});
					}, network))
					.then(L.bind(this.poll_status, this, nodes));
			}, this), 5);

			var table = E('div', { 'class': 'table assoclist', 'id': 'wifi_assoclist_table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th nowrap' }, _('Network')),
					E('div', { 'class': 'th hide-xs' }, _('MAC-Address')),
					E('div', { 'class': 'th' }, _('Host')),
					E('div', { 'class': 'th' }, _('Signal / Noise')),
					E('div', { 'class': 'th' }, _('RX Rate / TX Rate'))
				])
			]);

			cbi_update_table(table, [], E('em', { 'class': 'spinning' }, _('Collecting data...')))

			return E([ nodes, E('h3', _('Associated Stations')), table ]);
		}, this, m));
	}
});
