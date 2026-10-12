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
		fwrite(s, 1, strlen(s) + 1, f);
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

#define PORTS "[{\"num\":0,\"device\":\"eth1\",\"need_tag\":false}," \
              "{\"num\":1,\"role\":\"port\",\"index\":1}," \
              "{\"num\":2,\"role\":\"port\",\"index\":2}," \
              "{\"num\":3,\"role\":\"port\",\"index\":3}]"
#define BOARD "{\"model\":{\"id\":\"qcom,ipq5332-ap-mi01.6\"}," \
              "\"network\":{\"lan\":{\"ifname\":\"eth0\",\"protocol\":\"static\"}}"

static void check(const char *input, const char *expected)
{
	struct blob_buf actual = {}, wanted = {};
	char *a, *w;

	blob_buf_init(&actual, 0);
	blob_buf_init(&wanted, 0);
	assert(blobmsg_add_json_from_string(&actual, input));
	assert(blobmsg_add_json_from_string(&wanted, expected));
	rpc_luci_qsdk_switch(&actual);
	a = blobmsg_format_json(actual.head, true);
	w = blobmsg_format_json(wanted.head, true);
	assert(a && w);
	if (strcmp(a, w))
		fprintf(stderr, "Actual: %s\nExpected: %s\n", a, w);
	assert(!strcmp(a, w));
	free(a);
	free(w);
	blob_buf_free(&actual);
	blob_buf_free(&wanted);
}

int main(void)
{
	int i;

	check(BOARD "}", BOARD ",\"switch\":{\"switch1\":{\"ports\":" PORTS "}}}");
	check("{\"switch\":{\"switch0\":{\"ports\":[{\"num\":7,\"device\":\"eth9\"}]},"
	      "\"switch1\":{\"enable\":false,\"reset\":true,\"ports\":[]}},\"network\":{\"keep\":true}}",
	      "{\"network\":{\"keep\":true},\"switch\":{\"switch0\":{\"ports\":[{\"num\":7,\"device\":\"eth9\"}]},"
	      "\"switch1\":{\"enable\":false,\"reset\":true,\"ports\":" PORTS "}}}");
	check("{\"switch\":{\"switch1\":{\"enable\":false}}}",
	      "{\"switch\":{\"switch1\":{\"enable\":false,\"ports\":" PORTS "}}}");
	check("{\"switch\":{\"switch1\":{\"ports\":[{\"num\":2,\"role\":\"lan\"}]}}}",
	      "{\"switch\":{\"switch1\":{\"ports\":[{\"num\":2,\"role\":\"lan\"}]}}}");
	check("{\"switch\":false}", "{\"switch\":false}");
	check("{\"switch\":{\"switch1\":false}}", "{\"switch\":{\"switch1\":false}}");
	check("{\"switch\":{\"switch1\":{\"ports\":false}}}",
	      "{\"switch\":{\"switch1\":{\"ports\":false}}}");
	for (bad_property = 0; bad_property < 11; bad_property++)
		for (fault = 0; fault < (bad_property < 2 || bad_property >= 9 ? 2 : 4); fault++)
			check(BOARD "}", BOARD "}");
	bad_property = -1;
	for (i = 0; i < 20; i++)
		check("{}", "{\"switch\":{\"switch1\":{\"ports\":" PORTS "}}}");
	puts("QSDK Switch selfcheck passed: DT guards, CPU/port topology and preserved board metadata");
	return 0;
}
