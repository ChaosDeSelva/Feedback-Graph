import { createContext, useContext } from 'react';

/**
 * Whether this browser can make owner decisions. False on a tokenless install reached through Docker's published port:
 * the API cannot tell the browser from any other program on the machine, so owner actions stay read-only until
 * `./scripts/setup.sh --yes --enable-auth`. Owner controls are disabled rather than left to fail with a 403.
 */
export const OwnerWrites = createContext(true);
export const useOwnerWrites = () => useContext(OwnerWrites);
export const READ_ONLY_TITLE = 'Read-only: this install has no owner token (run ./scripts/setup.sh --yes --enable-auth)';
