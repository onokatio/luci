#include <assert.h>
#include <ctype.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <net/if.h>
#include <sys/wait.h>
#include <dirent.h>
#include <libubus.h>
#include <libubox/uloop.h>
#include "qsdk-hostapd.h"

int main(void)
{
	struct sockaddr_un server = { .sun_family = AF_UNIX }, client;
	socklen_t length;
	char reply[512], request[80];
	int socket_fd, status, i, n;
	pid_t child;
	assert(qsdk_hostapd_ifname("ath16") && !qsdk_hostapd_ifname("ath1;id") && !qsdk_hostapd_ifname("../ath1"));
	assert(qsdk_hostapd_mac("02:00:00:00:00:01"));
	assert(!qsdk_hostapd_mac("ff:ff:ff:ff:ff:ff") && !qsdk_hostapd_mac("00:00:00:00:00:00"));
	assert(!qsdk_hostapd_mac("02:00:00:00:00:zz") && !qsdk_hostapd_mac("02:00:00:00:00:01\n"));
	snprintf(server.sun_path, sizeof(server.sun_path), "/tmp/qsdk-ctrl-test-%ld", (long)getpid());
	socket_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	assert(socket_fd >= 0 && !bind(socket_fd, (struct sockaddr *)&server, sizeof(server)));
	child = fork();
	assert(child >= 0);
	if (!child) {
		for (i = 0; i < 3; i++) {
			length = sizeof(client);
			n = recvfrom(socket_fd, request, sizeof(request) - 1, 0, (struct sockaddr *)&client, &length);
			assert(n > 0);
			request[n] = 0;
			assert(!strcmp(request, i == 0 ? "PING" : i == 1 ? "FAILTEST" : "LONG"));
			memset(reply, 'x', sizeof(reply));
			assert(sendto(socket_fd, i == 0 ? "OK\n" : i == 1 ? "FAIL\n" : reply,
				i == 0 ? 3 : i == 1 ? 5 : sizeof(reply), 0, (struct sockaddr *)&client, length) > 0);
		}
		close(socket_fd);
		_exit(0);
	}
	assert(qsdk_hostapd_ok(server.sun_path, "PING"));
	assert(!qsdk_hostapd_ok(server.sun_path, "FAILTEST"));
	assert(qsdk_hostapd_request(server.sun_path, "LONG", reply, 16) < 0);
	assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
	close(socket_fd);
	unlink(server.sun_path);
	assert(qsdk_hostapd_request(server.sun_path, "PING", reply, sizeof(reply)) < 0);
	puts("QSDK hostapd control selfcheck passed: names, MACs, native IPC, failure and truncation");
	return 0;
}
