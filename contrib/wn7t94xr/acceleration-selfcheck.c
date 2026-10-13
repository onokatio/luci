#define _GNU_SOURCE
#include <assert.h>
#include <stdio.h>
#include <stdint.h>
#include <ctype.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <libubox/blobmsg_json.h>

struct ubus_context;
struct ubus_object;
struct ubus_request_data;
#define UBUS_STATUS_OK 0
static struct blob_buf blob;
static int ubus_send_reply(struct ubus_context *ctx, struct ubus_request_data *req, struct blob_attr *head) { return 0; }

static FILE *fixture(const char *path, const char *mode)
{
	const char *text = NULL;
	static char ppe[4096];
	if (strstr(path, "common_stats")) {
		strcpy(ppe, "PPE stats:\n [v4_l2_flows]: 26\n [invalid]: -1\n [overflow]: 18446744073709551616\nPPE flow stats:\n [v4_create_req]: 18446744073709551615\n");
		/* The stock dump has 271 lines, including tunnel counters near its end. */
		for (unsigned i = 0; i < 260; i++) strcat(ppe, "\n");
		strcat(ppe, "PPE tunnel stats:\n [late_counter]: 3\n");
		text = ppe;
	}
	else if (strstr(path, "ppe_ds_node_stats")) text = "Node 0\nTx pkts 123\nRx pkts 456\nNode 17\nTx pkts 99\n";
	else if (strstr(path, "ecm_ppe_ipv4/accelerated_count")) text = "13\n";
	else if (strstr(path, "ecm_ppe_ipv6/accelerated_count")) text = "0\n";
	return text ? fmemopen((void *)text, strlen(text), "r") : NULL;
}
#define fopen fixture
#include "qsdk-acceleration.h"
#undef fopen

int main(void)
{
	uint64_t n;
	assert(qsdk_counter("18446744073709551615\n", &n) && n == UINT64_MAX);
	assert(qsdk_counter("0", &n) && n == 0);
	assert(!qsdk_counter("18446744073709551616", &n));
	assert(!qsdk_counter("-1", &n));
	assert(!qsdk_counter("1oops", &n));
	assert(!qsdk_counter("", &n));
	rpc_luci_get_acceleration_status(NULL, NULL, NULL, NULL, NULL);
	char *json = blobmsg_format_json(blob.head, true);
	assert(strstr(json, "\"accelerated_count\":\"13\""));
	assert(strstr(json, "\"accelerated_count\":\"0\""));
	assert(strstr(json, "\"v4_create_req\":\"18446744073709551615\""));
	assert(!strstr(json, "\"invalid\""));
	assert(!strstr(json, "\"overflow\""));
	assert(strstr(json, "\"late_counter\":\"3\""));
	assert(strstr(json, "\"tx_packets\":\"123\""));
	assert(strstr(json, "\"rx_packets\":\"456\""));
	assert(!strstr(json, "\"tx_packets\":\"99\""));
	free(json);
	blob_buf_free(&blob);
	puts("QSDK acceleration selfcheck passed: exact counters, missing/zero, invalid values and bounded node IDs");
	return 0;
}
