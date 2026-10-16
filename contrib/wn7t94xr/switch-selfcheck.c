#include <assert.h>
#include <arpa/inet.h>
#include <ctype.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libubox/blobmsg_json.h>

static int bad_property = -1, fault;
static const char *properties[] = {
	"/sys/firmware/devicetree/base/compatible",
	"/sys/firmware/devicetree/base/soc/ess-instance/ess-switch1@1/compatible",
	"/sys/firmware/devicetree/base/soc/ess-instance/ess-switch1@1/device_id",
	"/sys/firmware/devicetree/base/soc/ess-instance/ess-switch1@1/switch_cpu_bmp",
	"/sys/firmware/devicetree/base/soc/ess-instance/ess-switch1@1/switch_lan_bmp",
	"/sys/firmware/devicetree/base/soc/ess-instance/ess-switch1@1/switch_wan_bmp",
	"/sys/firmware/devicetree/base/soc/dp2/qcom,id",
	"/sys/firmware/devicetree/base/soc/dp2/qcom,is_switch_connected",
	"/sys/firmware/devicetree/base/soc/dp2/qcom,mht-dev",
	"/sys/firmware/devicetree/base/aliases/ethernet1",
	"/sys/class/net/eth1/type"
};

static FILE *fixture_fopen(const char *path, const char *mode)
{
	static const uint32_t values[] = { 0, 0, 1, 1, 14, 0, 1, 1, 1 };
	uint32_t value;
	FILE *f;
	int i;

	(void)mode;
	for (i = 0; i < (int)(sizeof(properties) / sizeof(*properties)); i++)
		if (!strcmp(path, properties[i]))
			break;
	assert(i < (int)(sizeof(properties) / sizeof(*properties)));
	if (i == bad_property && fault == 0)
		return NULL;
	f = tmpfile();
	assert(f);
	if (i < 2 || i >= 9) {
		const char *s = i == bad_property ? "unrecognized" :
		               i == 0 ? "qcom,ipq5332-ap-mi01.6" :
		               i == 1 ? "qcom,ess-switch-qca8386" :
		               i == 9 ? "/soc/dp2" : "1\n";
		fwrite(s, 1, strlen(s) + (i == 10 ? 0 : 1), f);
	}
	else {
		value = htonl(values[i] + (i == bad_property && fault == 1));
		fwrite(&value, 1, i == bad_property && fault == 2 ? 3 : 4, f);
		if (i == bad_property && fault == 3)
			fputc(0, f);
	}
	rewind(f);
	return f;
}

#define fopen fixture_fopen
#include "qsdk-switch.inc"
#undef fopen

int main(void)
{
	assert(rpc_luci_qsdk_switch_supported());
	for (bad_property = 0; bad_property < 11; bad_property++)
		for (fault = 0; fault < (bad_property < 2 || bad_property >= 9 ? 2 : 4); fault++)
			assert(!rpc_luci_qsdk_switch_supported());
	puts("QSDK Switch selfcheck passed: DT guards");
	return 0;
}
