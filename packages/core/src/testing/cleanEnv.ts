/**
 * Variables a developer's shell may hold for their own install (its URL and tokens, its Compose project and files, the
 * Docker daemon it talks to). A test, or a script a test runs, that inherited one could act on that install. FG_TEST_*
 * variables configure the tests themselves and stay.
 */
export function isDeveloperVariable(name: string): boolean {
  return /^(FEEDBACK_|FG_(?!TEST_))/.test(name) || ['API_TOKEN', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'DOCKER_HOST'].includes(name);
}

/** env without the developer's variables. */
export function withoutDeveloperVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isDeveloperVariable(name)));
}
