/** INTAKE_ENABLED (default off): knowledge intake's routes, page and worker stages exist only while it is on. */
export function intakeEnabled(env: Record<string, string | undefined>): boolean { return /^(1|true|yes|on)$/i.test(env.INTAKE_ENABLED?.trim() ?? ''); }
