// `--name value` arguments of the perf scripts, with defaults.
export function args(defaults) {
  const out = { ...defaults };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "");
    if (!name || !(name in defaults)) {
      console.error(`unknown argument ${argv[i]}; known: ${Object.keys(defaults).join(", ")}`);
      process.exit(2);
    }
    const value = argv[i + 1];
    out[name] = typeof defaults[name] === "number" ? Number(value) : value;
  }
  return out;
}
