/* SPDX-License-Identifier: ISC */
/* Native QSDK hostapd control sockets behind the standard hostapd ubus API. */
#include <ctype.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <net/if.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <stddef.h>
#include <poll.h>
#include <fcntl.h>

static int qsdk_hostapd_ifname(const char *name)
{
	return name && !strncmp(name, "ath", 3) && strlen(name) > 3 &&
	       strlen(name) < IFNAMSIZ && strspn(name + 3, "0123456789") == strlen(name + 3);
}

static int qsdk_hostapd_mac(const char *mac)
{
	int i;
	if (!mac || strlen(mac) != 17) return 0;
	for (i = 0; i < 17; i++)
		if (i % 3 == 2 ? mac[i] != ':' : !isxdigit((unsigned char)mac[i])) return 0;
	return !(strtoul(mac, NULL, 16) & 1) && strcmp(mac, "00:00:00:00:00:00");
}

static int qsdk_hostapd_request(const char *path, const char *command, char *reply, size_t size)
{
	static unsigned int serial;
	struct sockaddr_un local = { .sun_family = AF_UNIX }, remote = { .sun_family = AF_UNIX };
	struct pollfd wait;
	int fd, len, ret = -1;
	if (strlen(path) >= sizeof(remote.sun_path) || size < 2) return -1;
	strcpy(remote.sun_path, path);
	len = snprintf(local.sun_path + 1, sizeof(local.sun_path) - 1, "rpcd-qsdk-%ld-%u", (long)getpid(), ++serial);
	fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	if (fd < 0) return -1;
	if (bind(fd, (struct sockaddr *)&local, offsetof(struct sockaddr_un, sun_path) + 1 + len) ||
	    connect(fd, (struct sockaddr *)&remote, sizeof(remote)) ||
	    send(fd, command, strlen(command), 0) != (ssize_t)strlen(command)) goto out;
	wait.fd = fd;
	wait.events = POLLIN;
	if (poll(&wait, 1, 250) != 1 || !(wait.revents & POLLIN)) goto out;
	len = recv(fd, reply, size - 1, MSG_TRUNC);
	if (len < 0 || (size_t)len >= size) goto out;
	reply[len] = 0;
	ret = len;
out:
	close(fd);
	return ret;
}
