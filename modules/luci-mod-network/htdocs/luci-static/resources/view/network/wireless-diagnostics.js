'use strict';
'require view';
'require rpc';
'require network';
'require ui';
'require poll';

var wmm=rpc.declare({object:'luci-rpc',method:'getWirelessWmm',params:['device'],expect:{'':{}},reject:true}),
    dscp=rpc.declare({object:'luci-rpc',method:'getWirelessDscpMap',params:['device'],expect:{'':{}},reject:true}),
    settings=rpc.declare({object:'luci-rpc',method:'getWirelessSettings',params:['device'],expect:{'':{}},reject:true});

var diagnostics = rpc.declare({ object: 'luci-rpc', method: 'getWirelessDiagnostics', params: ['device'], expect: { '': {} }, reject: true });

function surveyUsage(current, previous) {
	if (typeof BigInt != 'function') return '-';
	try {
		var total = BigInt(current.total), busy = BigInt(current.busy);
		if (previous) { total -= BigInt(previous.total); busy -= BigInt(previous.busy); }
		if (total <= BigInt(0) || busy < BigInt(0) || busy > total) return '-';
		return (Number(busy * BigInt(1000) / total) / 10).toFixed(1) + '%';
	} catch (e) { return '-'; }
}

function diagnosticTables(data, previous) {
	var current = (data.survey || []).find(function(s) { return !s.scan; }), old = previous && (previous.survey || []).find(function(s) { return !s.scan && current && s.frequency == current.frequency; }),
	    stats = E('table', { 'class': 'table' }, E('tr', {'class':'tr table-titles'}, [_('Metric'),_('Value')].map(function(t){return E('th',{'class':'th'},t);}))), survey = E('table', { 'class': 'table' }), history = E('table', { 'class': 'table' });
	cbi_update_table(stats, [
		[ _('Current channel'), current ? current.channel : '-' ],
		[ _('Channel busy since previous sample'), current && old ? surveyUsage(current, old) : '-' ],
		[ _('Reported noise'), data.noise < 0 ? data.noise + ' dBm' : '-' ],
		[ _('ACS state (native)'), data.acs_state == null ? '-' : data.acs_state ],
		[ _('CAC state (native)'), data.cac_state == null ? '-' : data.cac_state ],
		[ _('Automatic DFS puncturing'), data.dfs_puncture==null?'-':data.dfs_puncture ],
		[ _('Strict puncturing validation'), data.puncture_strict==null?'-':data.puncture_strict ],
		[ _('Strict airtime scheduling'), data.atf_strict==null?'-':data.atf_strict ],
		[ _('Strict scheduling between airtime groups'), data.atf_group_strict==null?'-':data.atf_group_strict ],
		[ _('Puncture bitmap'), data.puncture_bitmap == null ? '-' : '0x' + Number(data.puncture_bitmap).toString(16) ]
	]);
	survey.appendChild(E('tr', { 'class': 'tr table-titles' }, [ _('Channel'), _('Frequency'), _('Busy'), _('Sample') ].map(function(t) { return E('th', { 'class': 'th' }, t); })));
	cbi_update_table(survey, (data.survey || []).map(function(s) { return [ s.channel, s.frequency + ' MHz', surveyUsage(s), s.scan ? _('Last scan snapshot') : _('Cumulative home-channel sample') ]; }));
	history.appendChild(E('tr', { 'class': 'tr table-titles' }, [ _('Channel'), _('Band'), _('Selection time') ].map(function(t) { return E('th', { 'class': 'th' }, t); })));
	cbi_update_table(history, (data.history || []).map(function(h) { return [ h.channel, h.band, h.time ]; }));
	return [ stats, E('h3', {}, _('Channel survey')), E('p', {}, _('Scan samples are retained by the driver and may predate this page. Opening this page does not start a scan.')), survey, E('h3', {}, _('Channel history')), history ];
}

return view.extend({
	load: function() { return network.getWifiNetworks(); },
	render: function(nets) {
		var choices = nets.filter(function(n) { return /^ath[0-9]+$/.test(n.getIfname()) && !n.isDisabled(); }),
		    select = E('select', { 'class': 'cbi-input-select', 'aria-label': _('Wireless interface') }, choices.map(function(n) { return E('option', { 'value': n.getIfname() }, n.getShortName() + ' (' + n.getIfname() + ')'); })),
		    container = E('div'), qos=E('div'), previous = null, pending = false;
		function refresh() {
			if (pending || !select.value) return;
			pending = true;
			var device = select.value;
			return diagnostics(device).then(function(data) {
				if (device != select.value) return;
				container.replaceChildren.apply(container, diagnosticTables(data, previous)); previous = data;
			}).catch(function(e) { container.replaceChildren(E('p', {}, _('Wireless diagnostic data is unavailable: %s').format(e.message))); }).finally(function() { pending = false; });
		}
		select.addEventListener('change', function() { previous = null;qos.replaceChildren();refresh(); });
		var read=E('button',{'class':'cbi-button',click:ui.createHandlerFn(this,function(){var device=select.value;read.disabled=true;return Promise.all([wmm(device),dscp(device),settings(device)]).then(function(data){if(device!=select.value)return;var table=E('table',{'class':'table'},E('tr',{'class':'tr table-titles'},[_('Scope'),_('AC'),_('Parameter'),_('Value')].map(function(t){return E('th',{'class':'th'},t);})));cbi_update_table(table,(data[0].parameters || []).map(function(p){return [p.scope,p.category,p.parameter,p.value];}));var ds=E('table',{'class':'table'},E('tr',{'class':'tr table-titles'},[_('DSCP'),_('TID')].map(function(t){return E('th',{'class':'th'},t);})));cbi_update_table(ds,Object.keys(data[1].map || {}).map(function(k){return ['DSCP '+k,'TID '+data[1].map[k]];}));var atf=data[2];qos.replaceChildren(E('h3',{},_('Applied WMM parameters')),table,E('h3',{},_('Native DSCP map')),E('p',{},_('DSCP override: %s').format(atf.values && atf.values.dscp_override==1?_('enabled'):_('disabled'))),ds,E('h3',{},_('Native airtime tables')),E('pre',{},[atf.airtime || '',atf.showatfgroup || '',atf.showatfsubgroup || ''].join('\n')));}).catch(function(e){ui.addNotification(null,E('p',{},e.message));}).finally(function(){read.disabled=false;});})},_('Read QoS and ATF details'));
		poll.add(refresh, 10); refresh();
		return E('div', { 'class': 'cbi-map' }, [ E('h2', {}, _('Wireless diagnostics')), E('p', {}, _('Native radio statistics refresh every 10 seconds. Unreported values are shown as “-”.')), select, container,read,qos ]);
	},
	handleSave: null, handleSaveApply: null, handleReset: null
});
