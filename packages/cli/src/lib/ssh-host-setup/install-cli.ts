import { CANONICAL_URLS } from "@superset/shared/constants";
import type { HostTarget } from "./platform";

const INSTALL_URL = `${CANONICAL_URLS.MARKETING}/cli/install.sh`;
const RELEASE_DOWNLOAD_BASE =
	"https://github.com/paradevai/paradev/releases/download";

/**
 * Installs the CLI into ~/superset. A desktop release can ship before the CLI
 * release of the same version is published, so a pinned version that has no
 * tarball for this target falls back to the latest published CLI.
 */
export function installCliScript({
	version,
	target,
}: {
	version: string | null;
	target: HostTarget;
}): string {
	const pin = version
		? `tag=cli-v${version}
if [ "$(curl -sIL -o /dev/null -w '%{http_code}' ${RELEASE_DOWNLOAD_BASE}/cli-v${version}/superset-${target}.tar.gz)" = 404 ]; then
	echo "Paradev CLI ${version} is not published for ${target} yet; installing the latest release instead" >&2
	tag=latest
fi`
		: "tag=latest";
	return `set -e
script=$(mktemp)
trap 'rm -f "$script"' EXIT
curl -fsSL ${INSTALL_URL} -o "$script"
${pin}
SUPERSET_HOME="$HOME/superset" SUPERSET_VERSION=$tag sh "$script" --no-next-steps`;
}
