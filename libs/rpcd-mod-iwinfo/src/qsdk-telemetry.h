/* SPDX-License-Identifier: ISC */
#ifndef QSDK_TELEMETRY_H
#define QSDK_TELEMETRY_H
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <sys/wait.h>

#define QSDK_MCS_COUNT 17
#define QSDK_GI_COUNT 4
struct qsdk_pkt_type { uint32_t mcs[QSDK_MCS_COUNT], present; };
struct qsdk_usage {
	bool has_mcs, has_gi;
	struct qsdk_pkt_type modes[4];
	uint32_t gi[QSDK_GI_COUNT];
};
struct qsdk_telemetry { struct qsdk_usage rx, tx; };

static bool qsdk_usage_count(const char **cursor, uint32_t *value)
{
	char *end;
	unsigned long long count;
	while (isspace((unsigned char)**cursor)) (*cursor)++;
	if (!isdigit((unsigned char)**cursor)) return false;
	errno = 0;
	count = strtoull(*cursor, &end, 10);
	if (errno || count > UINT32_MAX) return false;
	*cursor = end;
	*value = count;
	return true;
}

static void qsdk_telemetry_parse(char *text, const char *vif, const char *mac, bool debug,
		struct qsdk_telemetry *result)
{
	static const char *modes[] = { "HT", "VHT", "HE", "EHT" };
	static const char *intervals[] = { "0.8us ", "0.4us ", "1.6us ", "3.2us " };
	char *line, *save, level[16], peer[18], parent[16], mode[4];
	struct qsdk_usage *usage = NULL;
	bool matched = false;
	unsigned int index, i;
	int offset;
	for (line = strtok_r(text, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
		while (isspace((unsigned char)*line)) line++;
		if (strstr(line, "Data STATS For STA")) {
			offset = 0;
			matched = sscanf(line, "%15s Data STATS For STA %17s (Parent %15[^)])%n", level, peer, parent, &offset) == 3 && offset > 0 &&
				!strcmp(level, debug ? "Debug" : "Advance") && !strcasecmp(peer, mac) && !strcmp(parent, vif);
			usage = NULL;
			continue;
		}
		if (!matched) continue;
		if (!strcmp(line, "Tx Stats")) { usage = &result->tx; continue; }
		if (!strcmp(line, "Rx Stats")) { usage = &result->rx; continue; }
		if (!usage) continue;
		if (!debug && (!strncmp(line, "Tx SGI = ", 9) || !strncmp(line, "Rx SGI = ", 9))) {
			const char *cursor = line + 9;
			uint32_t counts[QSDK_GI_COUNT];
			for (i = 0; i < QSDK_GI_COUNT; i++) {
				if (strncmp(cursor, intervals[i], 6)) break;
				cursor += 6;
				if (!qsdk_usage_count(&cursor, &counts[i])) break;
				if (i + 1 < QSDK_GI_COUNT) {
					if (strncmp(cursor, ", ", 2)) break;
					cursor += 2;
				}
			}
			while (isspace((unsigned char)*cursor)) cursor++;
			if (i == QSDK_GI_COUNT && !*cursor) {
				memcpy(usage->gi, counts, sizeof(counts));
				usage->has_gi = true;
			}
		} else if (debug && sscanf(line, "%3s MCS %2u %n", mode, &index, &offset) == 2 && index < QSDK_MCS_COUNT && line[offset] == '(') {
			const char *cursor = strrchr(line + offset, '=');
			uint32_t count;
			if (!cursor) continue;
			cursor++;
			if (!qsdk_usage_count(&cursor, &count)) continue;
			while (isspace((unsigned char)*cursor)) cursor++;
			if (*cursor) continue;
			for (i = 0; i < 4; i++) if (!strcmp(mode, modes[i])) {
				usage->modes[i].mcs[index] = count;
				usage->modes[i].present |= 1U << index;
				usage->has_mcs = true;
				break;
			}
		}
	}
}

static int64_t qsdk_telemetry_millis(void)
{
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static bool qsdk_telemetry_capture(const char *program, const char *level, const char *mac, char *text, size_t size)
{
	int pipefd[2], status = 0;
	pid_t child, waited;
	size_t length = 0;
	bool complete = false;
	if (pipe(pipefd)) return false;
	fcntl(pipefd[0], F_SETFD, FD_CLOEXEC);
	fcntl(pipefd[1], F_SETFD, FD_CLOEXEC);
	child = fork();
	if (!child) {
		int nullfd = open("/dev/null", O_WRONLY);
		dup2(pipefd[1], STDOUT_FILENO);
		if (nullfd >= 0) dup2(nullfd, STDERR_FILENO);
		close(pipefd[0]); close(pipefd[1]);
		if (nullfd > STDERR_FILENO) close(nullfd);
		execl(program, program, level, "-s", "-m", mac, "-f", "TX,RX", (char *)NULL);
		_exit(127);
	}
	close(pipefd[1]);
	if (child < 0) { close(pipefd[0]); return false; }
	int64_t deadline = qsdk_telemetry_millis() + 1500;
	while (length + 1 < size) {
		struct pollfd input = { .fd = pipefd[0], .events = POLLIN };
		int remaining = deadline - qsdk_telemetry_millis();
		if (remaining <= 0) break;
		int ready = poll(&input, 1, remaining);
		if (ready < 0 && errno == EINTR) continue;
		if (ready <= 0) break;
		ssize_t bytes = read(pipefd[0], text + length, size - length - 1);
		if (!bytes) { complete = true; break; }
		if (bytes < 0) { if (errno == EINTR) continue; break; }
		length += bytes;
	}
	close(pipefd[0]);
	text[length] = 0;
	do {
		waited = waitpid(child, &status, WNOHANG);
		if (waited == child || (waited < 0 && errno != EINTR)) break;
		if (qsdk_telemetry_millis() >= deadline) break;
		struct timespec delay = { .tv_nsec = 1000000 };
		nanosleep(&delay, NULL);
	} while (true);
	if (waited != child) {
		kill(child, SIGKILL);
		while (waitpid(child, &status, 0) < 0 && errno == EINTR) { }
		return false;
	}
	return complete && WIFEXITED(status) && !WEXITSTATUS(status);
}

static bool qsdk_telemetry_read(const char *vif, const char *mac, struct qsdk_telemetry *result)
{
	char text[32768];
	memset(result, 0, sizeof(*result));
	if (!qsdk_hostapd_ifname(vif) || !qsdk_hostapd_mac(mac)) return false;
	/* Native libnl-3 symbols conflict with RPCd's libnl-tiny; the stock executable isolates them. */
	if (qsdk_telemetry_capture("/usr/sbin/wifitelemetry", "-A", mac, text, sizeof(text)))
		qsdk_telemetry_parse(text, vif, mac, false, result);
	if (qsdk_telemetry_capture("/usr/sbin/wifitelemetry", "-D", mac, text, sizeof(text)))
		qsdk_telemetry_parse(text, vif, mac, true, result);
	return result->rx.has_mcs || result->rx.has_gi || result->tx.has_mcs || result->tx.has_gi;
}
#endif
