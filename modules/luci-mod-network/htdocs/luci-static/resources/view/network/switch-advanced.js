'use strict';
'require view';
'require rpc';
'require ui';

var get = rpc.declare({object:'luci-rpc',method:'getSwitchSettings',expect:{'':{}},reject:true}),
    set = rpc.declare({object:'luci-rpc',method:'setSwitchSettings',params:['monitor','ports'],expect:{'':{}},reject:true});

function integer(value,min,max) {
	return /^\d+$/.test(value) && +value>=min && +value<=max;
}

return view.extend({
	load:function() { return get(); },
	render:function(data) {
		var saved=data.saved || data.actual, fields={}, actual=E('div'), pending=false;
		function input(port,key,type) {
			var value=saved.ports[port][key] || 0, node=E('input',{type:type || 'number','aria-label':_('LAN%s %s').format(port,key)});
			if(type=='checkbox') node.checked=!!value; else {node.value=value;node.min=0;node.step=1;node.style.width='8em';}
			fields[port][key]=node; return node;
		}
		function show(status) {
			var rows=Object.keys(status.ports).map(function(port) {var p=status.ports[port];return ['LAN'+port,p.egress || '-',p.ingress || '-',p.storm || '-',p.priority,p.mirror_rx? _('RX'):'-',p.mirror_tx? _('TX'):'-'];});
			var table=E('table',{'class':'table'},E('tr',{'class':'tr table-titles'},[_('Port'),_('Egress (kbit/s)'),_('Ingress (kbit/s)'),_('Storm (packets/s)'),_('Priority'),_('Mirror RX'),_('Mirror TX')].map(function(t){return E('th',{'class':'th'},t);})));cbi_update_table(table,rows);actual.replaceChildren(table);
		}
		var monitor=E('select',{'aria-label':_('Mirror destination')},[E('option',{value:15},_('Disabled'))].concat([1,2,3].map(function(p){return E('option',{value:p},'LAN'+p);})));monitor.value=saved.monitor;
		var rows=[E('tr',{},[_('Port'),_('Egress kbit/s'),_('Ingress kbit/s'),_('Storm packets/s'),_('Storm classes'),_('Mirror'),_('Priority'),_('Trust DSCP'),_('Trust 802.1p')].map(function(t){return E('th',{},t);}))];
		[1,2,3].forEach(function(p){
			fields[p]={};var mask=saved.ports[p].storm_mask;
			var classes=[['broadcast',8,_('Broadcast')],['unknown_unicast',16,_('Unknown unicast')],['unknown_multicast',32,_('Unknown multicast')]].map(function(item){var box=E('input',{type:'checkbox'});box.checked=!!(mask&item[1]);fields[p][item[0]]=box;return E('label',{},[box,' '+item[2],E('br')]);});
			rows.push(E('tr',{},[E('th',{},'LAN'+p),E('td',{},input(p,'egress')),E('td',{},input(p,'ingress')),E('td',{},input(p,'storm')),E('td',{},classes),E('td',{},[E('label',{},[input(p,'mirror_rx','checkbox'),' RX']),E('label',{},[input(p,'mirror_tx','checkbox'),' TX'])]),E('td',{},input(p,'priority')),E('td',{},input(p,'dscp','checkbox')),E('td',{},input(p,'up','checkbox'))]));
		});
		show(data.actual);
		var button=E('button',{'class':'cbi-button cbi-button-apply',click:ui.createHandlerFn(this,function(){
			if(pending) return;var ports={};
			try {
				[1,2,3].forEach(function(p){var f=fields[p],v={storm_mask:0};['egress','ingress','storm','priority'].forEach(function(k){var max=k=='priority'?7:k=='storm'?1000000:2500000;if(!integer(f[k].value,0,max) || k!='priority' && +f[k].value>0 && +f[k].value<(k=='storm'?157:100)) throw new Error(_('Use 0 to disable a limiter, otherwise at least 100 kbit/s or 157 packets/s; priority is 0–7.'));v[k]=+f[k].value;});['mirror_rx','mirror_tx','dscp','up'].forEach(function(k){v[k]=+f[k].checked;});[['broadcast',8],['unknown_unicast',16],['unknown_multicast',32]].forEach(function(x){if(f[x[0]].checked)v.storm_mask|=x[1];});if(v.ingress && v.storm) throw new Error(_('Ingress rate and storm policing share one policer; choose one per port.'));if(v.storm && !v.storm_mask) throw new Error(_('Select at least one storm traffic class.'));if((v.mirror_rx || v.mirror_tx) && (+monitor.value==15 || +monitor.value==p)) throw new Error(_('Choose a different LAN port as the mirror destination.'));ports[p]=v;});
			} catch(error) {ui.addNotification(null,E('p',{},error.message));return;}
			pending=true;button.disabled=true;
			return set(+monitor.value,ports).then(show).then(function(){ui.addNotification(null,E('p',{},_('Saved and applied. Hardware values are quantized; the table shows the applied values.')));}).catch(function(error){ui.addNotification(null,E('p',{},_('Apply failed. Inspect system logs for rollback status: %s').format(error.message)));}).finally(function(){pending=false;button.disabled=false;});
		})},_('Save & Apply'));
		return E('div',{},[E('h2',{},_('Advanced switch controls')),E('p',{},_('Controls the external LAN1–3 switch. Rates apply to physical ports. 0 disables a limiter. Storm policing and ingress policing cannot be combined on the same port.')),E('p',{},[_('Mirror destination: '),monitor]),E('div',{'class':'table-responsive'},E('table',{'class':'table'},rows)),button,E('h3',{},_('Applied hardware settings')),actual]);
	},handleSave:null,handleSaveApply:null,handleReset:null
});
