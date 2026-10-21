export function supportsNodeVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  const minimum = new Map([
    [22, [23, 4]],
    [24, [22, 1]],
    [26, [12, 1]],
  ]).get(major);
  return !!minimum &&
    (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1]));
}

if (!supportsNodeVersion(process.versions.node)) {
  throw new Error(`Node.js ${process.versions.node} is unsupported; use Node 22.23.4+, 24.22.1+, or 26.12.1+ within those release lines.`);
}
