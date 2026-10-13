'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require fs';
'require poll';

var status = rpc.declare({ object: 'luci-rpc', method: 'getAccelerationStatus', expect: { '': {} }, reject: true }),
    set = rpc.declare({ object: 'uci', method: 'set', params: [ 'config', 'section', 'values' ], reject: true }),
    commit = rpc.declare({ object: 'uci', method: 'commit', params: [ 'config' ], reject: true });

function applySettings(values, original) {
	var attempted = false;
	function write(v) { return set('ecm', 'global', v).then(function() { return commit('ecm'); }); }
	function restart() { return fs.exec('/etc/init.d/qca-nss-ecm', [ 'restart' ]).then(function(r) { if (r.code !== 0) throw new Error(_('The native ECM service could not be restarted.')); }); }
	function verify(s, v) {
		if (!!s.loaded != (v.enabled == '1')) throw new Error(_('The ECM runtime does not match the saved configuration.'));
		if (s.loaded && v.acceleration_engine != 'auto') {
			var selected = v.acceleration_engine.split('-'), engines = s.engines || {};
			[ 'ppe', 'sfe', 'nss' ].forEach(function(name) {
				if ((selected.indexOf(name) >= 0) != !!(engines[name] && engines[name].ipv4 && engines[name].ipv4.accelerated_count != null)) throw new Error(_('The running acceleration engine does not match the saved configuration.'));
			});
		}
		return s;
	}
	return write(values).then(function() { attempted = true; return restart(); }).then(status).then(function(s) { return verify(s, values); }).catch(function(error) {
		return write(original).then(function() { if (attempted) return restart(); }).then(status).then(function(s) {
			verify(s, original);
			var restored = new Error(_('Previous settings restored: %s').format(error.message)); restored.restored = true; throw restored;
		}).catch(function(rollback) {
			if (rollback.restored) throw rollback;
			throw new Error(_('Applying failed and previous settings could not be restored. Check the ECM configuration: %s').format(rollback.message));
		});
	});
}

function number(value) { return value != null ? String(value) : '-'; }

function statistics(data) {
	var rows = [], engines = data.engines || {}, available = data.available || {};
	Object.keys(engines).forEach(function(name) {
		if (!available[name]) return;
		[ 'ipv4', 'ipv6' ].forEach(function(family) {
			var s = engines[name][family] || {};
			rows.push([ name.toUpperCase(), family.toUpperCase(), number(s.accelerated_count), number(s.tcp_accelerated_count), number(s.udp_accelerated_count), number(s.non_ported_accelerated_count), number(s.pending_accel_count), number(s.pending_decel_count) ]);
		});
	});
	var table = E('table', { 'class': 'table' }, E('tr', { 'class': 'tr table-titles' }, [ _('Engine'), _('Protocol'), _('Accelerated connections'), _('TCP'), _('UDP'), _('Other protocols'), _('Pending acceleration'), _('Pending deceleration') ].map(function(t) { return E('th', { 'class': 'th' }, t); })));
	cbi_update_table(table, rows);
	var nodes = [ E('p', {}, _('ECM: %s. Tracked connections: %s.').format(data.loaded ? _('running') : _('stopped'), number(data.connections))), E('p', {}, _('IPv4 acceleration: %s. IPv6 acceleration: %s.').format(data.ipv4_stop != null ? (data.ipv4_stop == '0' ? _('enabled') : _('paused')) : '-', data.ipv6_stop != null ? (data.ipv6_stop == '0' ? _('enabled') : _('paused')) : '-')), table ];
	[ ['ppe', _('PPE resources')], ['flows', _('PPE flow statistics')], ['tunnels', _('PPE tunnel statistics')] ].forEach(function(group) {
		var values = data[group[0]];
		if (!values || !Object.keys(values).length) return;
		var t = E('table', { 'class': 'table' }, E('tr', { 'class': 'tr table-titles' }, [ _('Counter'), _('Value') ].map(function(h) { return E('th', { 'class': 'th' }, h); })));
		cbi_update_table(t, Object.keys(values).map(function(key) { return [ key, number(values[key]) ]; }));
		nodes.push(E('details', {}, [ E('summary', {}, group[1]), t ]));
	});
	var ds = data.direct_switch || {};
	if (Object.keys(ds).length) {
		var t = E('table', { 'class': 'table' }, E('tr', { 'class': 'tr table-titles' }, [ _('Wi-Fi direct-switch node'), _('TX packets'), _('RX packets') ].map(function(h) { return E('th', { 'class': 'th' }, h); })));
		cbi_update_table(t, Object.keys(ds).map(function(key) { return [ key, number(ds[key].tx_packets), number(ds[key].rx_packets) ]; }));
		nodes.push(t);
	}
	return nodes;
}

function refresh(container, data) {
	var expanded = Array.from(container.querySelectorAll('details[open]')).map(function(d) { return d.firstElementChild.textContent; }), nodes = statistics(data);
	nodes.forEach(function(n) { if (n.localName == 'details') n.open = expanded.indexOf(n.firstElementChild.textContent) >= 0; });
	container.replaceChildren.apply(container, nodes);
}

return view.extend({
	load: function() { return Promise.all([ uci.load('ecm'), status() ]); },
	render: function(data) {
		var available = data[1].available || {}, original = { enabled: uci.get('ecm', 'global', 'enabled') || '0', acceleration_engine: uci.get('ecm', 'global', 'acceleration_engine') || 'auto' },
		    enabled = E('input', { 'id': 'ecm-enabled', 'type': 'checkbox', 'checked': original.enabled == '1' ? '' : null }),
		    engine = E('select', { 'id': 'ecm-engine', 'class': 'cbi-input-select' }), choices = [ [ 'auto', _('Automatic') ] ];
		if (available.ppe) choices.push([ 'ppe', _('PPE hardware acceleration') ]);
		if (available.sfe) choices.push([ 'sfe', _('SFE software acceleration') ]);
		if (available.ppe && available.sfe) choices.push([ 'ppe-sfe', _('PPE with SFE fallback') ]);
		if (available.nss) choices.push([ 'nss', _('NSS hardware acceleration') ]);
		if (available.nss && available.sfe) choices.push([ 'nss-sfe', _('NSS with SFE fallback') ]);
		choices.forEach(function(c) { engine.appendChild(E('option', { 'value': c[0] }, c[1])); });
		engine.value = original.acceleration_engine;
		var stats = E('div', {}, statistics(data[1])), pending = false;
		poll.add(function() {
			if (pending) return;
			return status().then(function(s) { refresh(stats, s); }).catch(function() { stats.replaceChildren(E('p', {}, _('Acceleration statistics are unavailable.'))); });
		}, 5);
		var apply = E('button', { 'class': 'cbi-button cbi-button-apply', 'click': ui.createHandlerFn(this, function() {
			var values = { enabled: enabled.checked ? '1' : '0', acceleration_engine: engine.value };
			if (!choices.some(function(c) { return c[0] == values.acceleration_engine; })) return ui.addNotification(null, E('p', {}, _('Unsupported acceleration engine')), 'error');
			if (values.enabled == original.enabled && values.acceleration_engine == original.acceleration_engine) return;
			pending = true;
			return applySettings(values, original).then(function(s) {
				original = values;
				refresh(stats, s);
				ui.addNotification(null, E('p', {}, _('Acceleration settings applied.')), 'info');
			}).catch(function(error) {
				if (error.restored) { enabled.checked = original.enabled == '1'; engine.value = original.acceleration_engine; }
				ui.addNotification(null, E('p', {}, error.message), 'error');
			}).finally(function() { pending = false; uci.unload('ecm'); });
		}) }, _('Apply'));
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Acceleration')),
			E('p', {}, _('Manage the native QSDK connection accelerator. Applying changes reloads ECM and may briefly reduce throughput. Settings are retained across reboots.')),
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title', 'for': 'ecm-enabled' }, _('Enable acceleration')), E('div', { 'class': 'cbi-value-field' }, enabled) ]),
			E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title', 'for': 'ecm-engine' }, _('Acceleration engine')), E('div', { 'class': 'cbi-value-field' }, engine) ]),
			E('p', {}, apply), E('h3', {}, _('Statistics')), E('p', {}, _('Current connection counts and cumulative driver counters are refreshed every 5 seconds. Unreported values are shown as “-”.')), stats
		]);
	},
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
