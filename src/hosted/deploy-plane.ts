import type { VaultEnvName } from "../hosted-types.ts";

/**
 * Environments this deploy may list or store.
 * The staging plane never serves production items.
 */
export function environmentsForDeployPlane(plane: VaultEnvName): readonly VaultEnvName[] {
  return plane === "staging" ? ["staging"] : ["staging", "production"];
}

export function deployPlaneAllowsEnvironment(
  plane: VaultEnvName,
  environment: VaultEnvName,
): boolean {
  return environmentsForDeployPlane(plane).includes(environment);
}

/**
 * The environment a client gets when nothing else chose one (OAuth-issued clients, the operator
 * stdio shim). It is the plane itself: production-bound agents must see production items (D1).
 */
export function defaultEnvironmentForDeployPlane(plane: VaultEnvName): VaultEnvName {
  return plane;
}
