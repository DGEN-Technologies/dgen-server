import pino from "pino";

export const l = (...msgs: any[]) => pino().info(msgs.join(" "));
export const warn = (...msgs: any[]) => pino().warn(msgs.join(" "));
export const err = (...msgs: any[]) => pino().error(msgs.join(" "));

export const line = () => {
  const stack = new Error().stack;
  const stackLine = stack.split("\n")[1];
  const match = stackLine.match(/at\s+(.*):(\d+):(\d+)/);
  return `${match[1]}:${match[2]}`;
};
