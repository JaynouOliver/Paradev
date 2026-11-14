import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostKeyName } from "./host-key";
import { installCliScript } from "./install-cli";
import { machineIdProblem } from "./machine-id";
import { checkPlatform } from "./platform";
import { parseProbe } from "./probe";
import { launchdPlist, systemdUnit } from "./service";
import { sshFailureHint } from "./ssh-failure-hint";

describe("checkPlatform", () => {
	test("maps uname output to a release target", () => {
		expect(
			checkPlatform("Linux", "aarch64", "ldd (Ubuntu GLIBC 2.39) 2.39"),
		).toEqual({
			ok: true,
			target: "linux-arm64",
		});
		expect(checkPlatform("Darwin", "x86_64", "")).toEqual({
			ok: true,
			target: "darwin-x64",
		});
	});

	test("refuses musl Linux, other systems and other architectures with the reason", () => {
		expect(
			checkPlatform("Linux", "x86_64", "musl libc (x86_64)"),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("glibc"),
		});
		expect(checkPlatform("FreeBSD", "amd64", "")).toMatchObject({ ok: false });
		expect(checkPlatform("Linux", "riscv64", "")).toMatchObject({ ok: false });
	});
});

describe("machineIdProblem", () => {
	test("flags an empty or placeholder id, accepts a real one", () => {
		expect(machineIdProblem("\n")).toContain("empty");
		expect(machineIdProblem("uninitialized")).toContain("empty");
		expect(machineIdProblem("3f1c2b0e9d8a4c7b6e5f4a3b2c1d0e9f\n")).toBeNull();
	});
});

describe("service files", () => {
	const input = {
		binPath: "/home/me/superset/bin/superset",
		organizationId: "org-1",
	};

	test("the systemd unit runs start in the foreground and keeps terminals on restart", () => {
		const unit = systemdUnit(input);
		expect(unit).toContain(
			'ExecStart="/home/me/superset/bin/superset" start --org "org-1"',
		);
		expect(unit).toContain("KillMode=process");
		expect(unit).not.toContain("--daemon");
	});

	test("the LaunchAgent restarts the host unless it exited cleanly", () => {
		const plist = launchdPlist(input);
		expect(plist).toContain("<string>start</string>");
		expect(plist).toContain("<key>SuccessfulExit</key>\n\t\t<false/>");
	});
});

describe("parseProbe", () => {
	test("reads the id the host derives its host id from on each system", () => {
		const linux = parseProbe(
			"system=Linux\nmachineid=abc\nversion=superset 1.37.0\nlinger=no\nbin=\n",
		);
		expect(linux).toMatchObject({
			machineId: "abc",
			version: "1.37.0",
			linger: false,
			bin: null,
			gh: null,
		});
		const mac = parseProbe(
			'system=Darwin\nmachineid=\nioreg=      "IOPlatformUUID" = "1234-ABCD"\n',
		);
		expect(mac.machineId).toBe("1234-ABCD");
	});
});

test("the systemd unit keeps a path with spaces and % as one word", () => {
	const unit = systemdUnit({
		binPath: "/home/Jo Doe/100%/superset",
		organizationId: "org-1",
	});
	expect(unit).toContain('ExecStart="/home/Jo Doe/100%%/superset" start');
});

test("the host key name fits better-auth's 32-character limit", () => {
	const name = hostKeyName(
		"Manageds-Virtual-Machine.local",
		"a97d7f26b38197e34cb10dc80a4461a8",
	);
	expect(name).toBe("Host a97d7f26 Manageds-Virtual-M");
	expect(name.length).toBeLessThanOrEqual(32);
});

describe("sshFailureHint", () => {
	test("names the cause ssh reported", () => {
		expect(
			sshFailureHint("Connection closed by 127.0.0.1 port 2233", "box"),
		).toContain("2 minutes");
		expect(
			sshFailureHint("dev@box: Permission denied (publickey,password).", "box"),
		).toContain("refused the login");
		expect(sshFailureHint("Host key verification failed.", "box")).toContain(
			"ssh-keygen -R",
		);
		expect(
			sshFailureHint("ssh: Could not resolve hostname nobox", "nobox"),
		).toContain("does not resolve");
		expect(sshFailureHint("", "box")).toBe(
			"Check it in a terminal first: ssh box",
		);
	});
});

describe("installCliScript", () => {
	const FAKE_CURL = `#!/bin/sh
out=
for arg in "$@"; do
	case "$arg" in */cli-v2.0.6/superset-darwin-arm64.tar.gz) printf 404; exit 0 ;; esac
	case "$arg" in */releases/download/*) printf 200; exit 0 ;; esac
done
while [ $# -gt 0 ]; do
	[ "$1" = -o ] && out=$2
	shift
done
echo 'printf %s "$SUPERSET_VERSION" > "$HOME/installed-tag"' > "$out"
`;

	function installedTag(version: string | null): {
		tag: string;
		stderr: string;
	} {
		const home = mkdtempSync(join(tmpdir(), "install-cli-"));
		try {
			writeFileSync(join(home, "curl"), FAKE_CURL);
			chmodSync(join(home, "curl"), 0o755);
			const result = Bun.spawnSync(
				["sh", "-c", installCliScript({ version, target: "darwin-arm64" })],
				{ env: { HOME: home, PATH: `${home}:${process.env.PATH}` } },
			);
			expect(result.exitCode).toBe(0);
			return {
				tag: readFileSync(join(home, "installed-tag"), "utf8"),
				stderr: result.stderr.toString(),
			};
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}

	test("installs the pinned release when it is published", () => {
		expect(installedTag("2.0.5")).toEqual({ tag: "cli-v2.0.5", stderr: "" });
	});

	test("falls back to the latest release when the pinned one is not published", () => {
		const { tag, stderr } = installedTag("2.0.6");
		expect(tag).toBe("latest");
		expect(stderr).toContain("Paradev CLI 2.0.6 is not published");
	});

	test("installs the latest release from a dev build", () => {
		expect(installedTag(null).tag).toBe("latest");
	});
});
