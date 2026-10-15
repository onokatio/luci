'use strict';
'require view';
'require rpc';
'require uci';
'require fs';
'require ui';

var service=rpc.declare({object:'service',method:'list',params:['name'],expect:{'':{}},reject:true}),
    commit=rpc.declare({object:'uci',method:'commit',params:['config'],reject:true});
var settings=[['config','Enable',_('Enable band steering'),0,1],
 ['IdleSteer','RSSISteeringPoint_DG',_('Downward RSSI threshold (dB)'),0,255],
 ['IdleSteer','RSSISteeringPoint_UG',_('Upward RSSI threshold (dB)'),0,255],
 ['Offload','MUOverloadThreshold_W2',_('2.4 GHz overload (%)'),0,100],
 ['Offload','MUSafetyThreshold_W2',_('2.4 GHz safety threshold (%)'),0,100],
 ['Offload','MUOverloadThreshold_W5',_('5 GHz overload (%)'),0,100],
 ['Offload','MUSafetyThreshold_W5',_('5 GHz safety threshold (%)'),0,100]];
function steeringRunning(reply) {
	return Object.keys((reply.lbd || {}).instances || {}).some(function(k){return reply.lbd.instances[k].running===true;});
}
function steeringConflict() {
	return [['repacd','repacd'],['ezmesh','config'],['hyd','config']].some(function(k){return uci.get(k[0],k[1],'Enable')=='1';});
}
function native(action) {return fs.exec('/etc/init.d/lbd',[action]).then(function(r){if(r.code!==0)throw new Error(_('The native band steering service failed: %s').format(r.stderr || action));});}
return view.extend({
	load:function(){return Promise.all(['lbd','repacd','ezmesh','hyd'].map(function(c){return uci.load(c);})).then(function(){return Promise.all([service('lbd'),fs.exec('/etc/init.d/lbd',['enabled'])]);});},
	render:function(data){
		var reply=data[0],wasEnabled=data[1].code===0,wasRunning=steeringRunning(reply);
		var original=settings.map(function(s){return uci.get('lbd',s[0],s[1]);}), inputs=[], status=E('p',{},steeringRunning(reply)?_('Native lbd is running.'):_('Native lbd is stopped.')), pending=false, attempted=false;
		var rows=settings.map(function(s,i){var checkbox=i==0,field=E('input',{type:checkbox?'checkbox':'number',min:s[3],max:s[4],step:1,'aria-label':s[2]});if(checkbox)field.checked=original[i]=='1';else field.value=original[i];inputs.push(field);return E('div',{'class':'cbi-value'},[E('label',{'class':'cbi-value-title'},s[2]),E('div',{'class':'cbi-value-field'},field)]);});
		function write(values){settings.forEach(function(s,i){if(values[i]==null)uci.unset('lbd',s[0],s[1]);else uci.set('lbd',s[0],s[1],String(values[i]));});return uci.save().then(function(){return commit('lbd');});}
		var button=E('button',{'class':'cbi-button cbi-button-apply',click:ui.createHandlerFn(this,function(){
			if(pending)return;var values=inputs.map(function(f,i){return i==0?(f.checked?'1':'0'):f.value;});
			for(var i=0;i<settings.length;i++)if(!/^\d+$/.test(values[i]) || +values[i]<settings[i][3] || +values[i]>settings[i][4]){ui.addNotification(null,E('p',{},_('A threshold is outside its allowed range.')));return;}
			if(+values[1]>=+values[2] || +values[4]>=+values[3] || +values[6]>=+values[5]){ui.addNotification(null,E('p',{},_('Downward RSSI must be lower than upward RSSI; safety load must be lower than overload load.')));return;}
			pending=true;attempted=false;button.disabled=true;
			['repacd','ezmesh','hyd'].forEach(function(c){uci.unload(c);});
			return Promise.all(['repacd','ezmesh','hyd'].map(function(c){return uci.load(c);})).then(function(){
				if(steeringConflict())throw new Error(_('EasyMesh/SON owns steering. Disable its native controller before editing standalone lbd.'));
				return values[0]=='1'?fs.exec('/usr/sbin/repacdcli',['athx','get_all_freq']).then(function(r){var bands=(r.stdout || '').trim().split(/\s+/);if(r.code!==0 || bands.indexOf('2')<0 || bands.indexOf('5')<0)throw new Error(_('Enable APs on both 2.4 GHz and 5 GHz first.'));}):null;
			}).then(function(){attempted=true;return write(values);}).then(function(){return native(values[0]=='1'?'enable':'disable');}).then(function(){return native(values[0]=='1'?'restart':'stop');}).then(function(){return service('lbd');}).then(function(s){if(steeringRunning(s)!=(values[0]=='1'))throw new Error(_('The native service did not reach the requested state.'));original=values;wasEnabled=values[0]=='1';wasRunning=steeringRunning(s);status.textContent=steeringRunning(s)?_('Native lbd is running.'):_('Native lbd is stopped.');}).catch(function(error){
				if(!attempted){ui.addNotification(null,E('p',{},error.message));return;}
				return write(original).then(function(){return native(wasEnabled?'enable':'disable');}).then(function(){return native(wasRunning?'restart':'stop');}).then(function(){ui.addNotification(null,E('p',{},_('Previous settings restored: %s').format(error.message)));}).catch(function(rollback){ui.addNotification(null,E('p',{},_('Rollback failed; check the native lbd configuration: %s').format(rollback.message)));});
			}).finally(function(){pending=false;button.disabled=false;});
		})},_('Save & Apply'));
		return E('div',{},[E('h2',{},_('Native band steering')),E('p',{},_('Requires active APs on both 2.4 GHz and 5 GHz with matching SSIDs and security. RSSI thresholds use the native positive dB metric, not negative dBm. EasyMesh/SON and standalone steering cannot share ownership.')),status].concat(rows,[button]));
	},handleSave:null,handleSaveApply:null,handleReset:null
});
