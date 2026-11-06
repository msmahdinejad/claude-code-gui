// Sign a connection profile in from the UI (the CLI's `auth login`), for when the OAuth session has expired.
import { profileEnv, resolveCommand } from "../config.mjs";
import { LoginFlows } from "../login.mjs";

export default function register({ route, config, catalog, HttpError }) {
  const flows = new LoginFlows({
    resolve(name) {
      const profile = config.profiles[name];
      if (!profile) return { problem: `Unknown profile: ${name}` };
      const env = profileEnv(config, name);
      const executable = resolveCommand(profile.command, env);
      return executable.problem ? { problem: executable.problem } : { path: executable.path, env };
    },
  });
  // Models and commands come from the account: look again once it is a different (or a valid) login.
  flows.on("done", () => catalog.invalidate());

  const guard = (work) => {
    try {
      return work();
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  };
  const known = (id) => {
    const flow = flows.get(id);
    if (!flow) throw new HttpError(404, "unknown sign-in");
    return flow;
  };

  route("POST", "/api/auth/login", async ({ body }) => guard(() => flows.start(String(body?.name || config.activeProfile))));
  route("GET", "/api/auth/login/([^/]+)", async ({ params }) => known(params[0]));
  route("POST", "/api/auth/login/([^/]+)/code", async ({ params, body }) => {
    known(params[0]);
    return guard(() => flows.submitCode(params[0], body?.code));
  });
  route("POST", "/api/auth/login/([^/]+)/cancel", async ({ params }) => {
    known(params[0]);
    return flows.cancel(params[0]);
  });
}
