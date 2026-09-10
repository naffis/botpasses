import type { DeployPlane } from "../brand.ts";
import type { VaultEnvName } from "../hosted-types.ts";

/**
 * Environments this deploy may list or store.
 * The staging plane never serves production items. Plane `dev` lists both, like production.
 */
export function environmentsForDeployPlane(plane: DeployPlane): readonly VaultEnvName[] {
  return plane === "staging" ? ["staging"] : ["staging", "production"];
}

export function deployPlaneAllowsEnvironment(
  plane: DeployPlane,
  environment: VaultEnvName,
): boolean {
  return environmentsForDeployPlane(plane).includes(environment);
}

/**
 * The environment a client gets when nothing else chose one (OAuth-issued clients, the operator
 * stdio shim). Production stays production. Staging and `dev` default to staging so `dev` is
 * never written as a vault environment.
 */
export function defaultEnvironmentForDeployPlane(plane: DeployPlane): VaultEnvName {
  return plane === "production" ? "production" : "staging";
}
