/* SPDX-License-Identifier: ISC */
#include <stdbool.h>
#include <stdint.h>
#include <errno.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <sys/wait.h>
#include <unistd.h>

static int64_t qsdk_exec_millis(void)
{
	struct timespec now;
	clock_gettime(CLOCK_MONOTONIC, &now);
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static bool qsdk_exec_capture(const char *const argv[], char *text, size_t size, int timeout, bool capture_stderr)
{
	int pipefd[2], status = 0;
	pid_t child, waited;
	size_t length = 0;
	bool complete = false;
	if (size < 2 || timeout <= 0 || pipe(pipefd)) return false;
	fcntl(pipefd[0], F_SETFD, FD_CLOEXEC);
	fcntl(pipefd[1], F_SETFD, FD_CLOEXEC);
	child = fork();
	if (!child) {
		close(pipefd[0]);
		if (dup2(pipefd[1], STDOUT_FILENO) < 0) _exit(127);
		fcntl(STDOUT_FILENO, F_SETFD, 0);
		if (pipefd[1] != STDOUT_FILENO) close(pipefd[1]);
		if (capture_stderr) dup2(STDOUT_FILENO, STDERR_FILENO);
		else {
			int nullfd = open("/dev/null", O_WRONLY);
			if (nullfd >= 0) dup2(nullfd, STDERR_FILENO);
			if (nullfd > STDERR_FILENO) close(nullfd);
		}
		execv(argv[0], (char *const *)argv);
		_exit(127);
	}
	close(pipefd[1]);
	if (child < 0) { close(pipefd[0]); return false; }
	int64_t deadline = qsdk_exec_millis() + timeout;
	while (length + 1 < size) {
		struct pollfd input = { .fd = pipefd[0], .events = POLLIN };
		int remaining = deadline - qsdk_exec_millis();
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
		if (qsdk_exec_millis() >= deadline) break;
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

