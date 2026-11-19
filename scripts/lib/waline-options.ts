export interface WalineSourceOptions {
  input: string;
  skipPaths: string[];
}

export function readWalineSourceOption(
  args: string[],
  index: number,
  options: WalineSourceOptions,
): number | undefined {
  const argument = args[index];
  if (!argument) return undefined;
  for (const flag of ["--input", "--skip-paths"]) {
    const inline = argument.startsWith(`${flag}=`);
    const next = args[index + 1];
    const value = inline
      ? argument.slice(flag.length + 1)
      : argument === flag && next
        ? next
        : undefined;
    if (value === undefined) continue;
    if (flag === "--input") options.input = value;
    else
      options.skipPaths.push(
        ...value
          .split(",")
          .map((path) => path.trim())
          .filter(Boolean),
      );
    return inline ? index : index + 1;
  }
  if (!argument.startsWith("--") && !options.input) {
    options.input = argument;
    return index;
  }
  return undefined;
}
