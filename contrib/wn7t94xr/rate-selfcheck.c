#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <libubox/blobmsg_json.h>
#include <iwinfo.h>
static struct blob_buf buf;
#include "qsdk-rate.inc"

int main(void)
{
	struct iwinfo_rate_entry rate = { .rate = 5764800, .mcs = -1, .is_eht = 1, .is_320mhz = 1, .nss = 2 };
	struct blob_attr *tb[4];
	const struct blobmsg_policy policy[] = {
		{ .name = "mhz", .type = BLOBMSG_TYPE_INT32 },
		{ .name = "eht", .type = BLOBMSG_TYPE_BOOL },
		{ .name = "mcs", .type = BLOBMSG_TYPE_INT32 },
		{ .name = "nss", .type = BLOBMSG_TYPE_INT32 },
	};
	blob_buf_init(&buf, 0);
	rpc_iwinfo_add_rateinfo(&rate);
	blobmsg_parse(policy, 4, tb, blob_data(buf.head), blob_len(buf.head));
	assert(tb[0] && blobmsg_get_u32(tb[0]) == 320);
	assert(tb[1] && blobmsg_get_bool(tb[1]));
	assert(!tb[2] && tb[3] && blobmsg_get_u32(tb[3]) == 2);
	blob_buf_free(&buf);
	puts("QSDK rate selfcheck passed: 320 MHz, NSS, and unknown MCS");
	return 0;
}
