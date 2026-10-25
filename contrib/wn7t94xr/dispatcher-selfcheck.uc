import dispatch from 'luci.dispatcher';

// Import the complete dispatcher with a probe instead of opening a real ubus socket.
let connected = false;
try {
	dispatch(null);
}
catch (e) {
	if (e.message != 'dispatcher-selfcheck-connect')
		throw e;
	connected = true;
}
if (!connected)
	die('Dispatcher must open ubus when handling a request, not during preload');
print('PASS: dispatcher imports without connecting; requests create their own ubus connection\n');
