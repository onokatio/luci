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
static char captured[4096], response[8192] = "OK\n", *sent;
static const char *native_status, *native_station;
static int ubus_send_reply(struct ubus_context *ctx, struct ubus_request_data *req, struct blob_attr *head)
{ free(sent); sent = blobmsg_format_json(head, true); return 0; }
static int capture(const char *path, const char *command, char *reply, size_t size)
{
 const char *value = response;
 if (native_status && !strcmp(command, "STATUS")) value = native_status;
 else if (native_station && !strcmp(command, "STA-FIRST")) value = native_station;
 else if (native_station && !strncmp(command, "STA-NEXT ", 9)) value = "FAIL\n";
 snprintf(captured, sizeof(captured), "%s", command); snprintf(reply, size, "%s", value); return strlen(reply);
}
#define qsdk_hostapd_request capture
static int qsdk_hostapd_ok(const char *path, const char *command)
{ char reply[64]; return capture(path, command, reply, sizeof(reply)) >= 0 && !strcmp(reply, "OK\n"); }
#include "qsdk-hostapd-management.h"
#include "qsdk-hostapd-info.h"
int main(void)
{
 struct blob_buf args = {}; struct qsdk_hostapd_vif vif = {};
 blob_buf_init(&args, 0);
 assert(blobmsg_add_json_from_string(&args, "{\"addr\":\"02:00:00:00:00:01\",\"op_class\":115,\"channel\":36,\"duration\":50,\"mode\":0,\"ssid\":\"test\"}"));
 assert(!qsdk_hostapd_transition(NULL,&vif.object,NULL,"rrm_beacon_req",args.head));
 assert(!strcmp(captured, "REQ_BEACON 02:00:00:00:00:01 73240000320000ffffffffffff000474657374"));
 blob_buf_free(&args); blob_buf_init(&args, 0);
 assert(blobmsg_add_json_from_string(&args,"{\"addr\":\"02:00:00:00:00:01\",\"op_class\":115,\"channel\":36,\"duration\":65536,\"mode\":0}"));
 assert(qsdk_hostapd_transition(NULL,&vif.object,NULL,"rrm_beacon_req",args.head)==UBUS_STATUS_INVALID_ARGUMENT);
 strcpy(response, "PBC Status: Active\nLast WPS result: None\n");
 assert(!qsdk_hostapd_wps(NULL,&vif.object,NULL,"wps_status",NULL));
 assert(strstr(sent,"\"last_wps_result\":\"None\""));
 strcpy(response,"02:11:22:33:44:66 ssid=74657374 nr=02112233446600000000732409\n");
 assert(!qsdk_hostapd_neighbor(NULL,&vif.object,NULL,"rrm_nr_list",NULL));
 assert(strstr(sent,"test") && strstr(sent,"02112233446600000000732409"));
 assert(qsdk_hostapd_report("02112233446600000000732409"));
 assert(!qsdk_hostapd_report("02112233446600000000732409030201"));
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
 free(sent); blob_buf_free(&args);
 puts("QSDK wireless management selfcheck passed: standard beacon encoding, bounds, WPS and neighbor reports");
 return 0;
}
