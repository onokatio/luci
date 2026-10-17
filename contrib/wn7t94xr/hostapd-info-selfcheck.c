#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <libubox/blobmsg_json.h>
#include <libubox/list.h>
#include "qsdk-hostapd-control.h"
struct ubus_context; struct ubus_request_data;
struct ubus_object { int unused; };
struct qsdk_hostapd_vif { struct ubus_object object; char name[24], path[108]; };
#define UBUS_STATUS_OK 0
#define UBUS_STATUS_INVALID_ARGUMENT 2
#define UBUS_STATUS_NOT_SUPPORTED 8
#define UBUS_STATUS_UNKNOWN_ERROR 9
static char response[8192] = "OK\n", *sent;
static const char *native_status, *native_station;
static int ubus_send_reply(struct ubus_context *ctx, struct ubus_request_data *req, struct blob_attr *head)
{ free(sent); sent = blobmsg_format_json(head, true); return 0; }
static int capture(const char *path, const char *command, char *reply, size_t size)
{
 const char *value = response;
 if (native_status && !strcmp(command, "STATUS")) value = native_status;
 else if (native_station && !strcmp(command, "STA-FIRST")) value = native_station;
 else if (native_station && !strncmp(command, "STA-NEXT ", 9)) value = "FAIL\n";
 snprintf(reply, size, "%s", value); return strlen(reply);
}
#define qsdk_hostapd_request capture
#include "qsdk-hostapd-info.h"
int main(void)
{
 struct qsdk_hostapd_vif vif = {};
 native_status = "state=ENABLED\nphy=wifi1\nfreq=5180\nchannel=36\nbeacon_int=100\nssid[0]=safe<text>\nbssid[0]=02:00:00:00:00:01\ncac_time_left_seconds=0\n";
 assert(!qsdk_hostapd_info(NULL,&vif.object,NULL,"get_status",NULL));
 assert(strstr(sent,"\"status\":\"ENABLED\"") && strstr(sent,"\"freq\":5180"));
 native_station = "02:00:00:00:00:02\nflags=[AUTHORIZED][ASSOC][WMM][HE]\naid=1\nrx_bytes=4294967298\ntx_bytes=-1\n";
 assert(!qsdk_hostapd_info(NULL,&vif.object,NULL,"get_clients",NULL));
 assert(strstr(sent,"\"authorized\":true") && strstr(sent,"\"auth\":false"));
 assert(strstr(sent,"4294967298") && !strstr(sent,"\"tx\""));
 native_station = "02:00:00:00:00:02junk\nflags=[AUTH]\n";
 assert(qsdk_hostapd_info(NULL,&vif.object,NULL,"get_clients",NULL)==UBUS_STATUS_UNKNOWN_ERROR);
 uint64_t number;
 assert(!qsdk_hostapd_unsigned("value=-1\n","value",&number));
 assert(!qsdk_hostapd_unsigned("value=18446744073709551616\n","value",&number));
 assert(!qsdk_hostapd_unsigned("value=1junk\n","value",&number));
 free(sent);
 puts("QSDK hostapd info selfcheck passed: standard status, clients and bounded counters");
 return 0;
}
