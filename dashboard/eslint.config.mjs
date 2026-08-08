import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Ratchet, not a verdict. These two React 19 hook rules flag 13 spots in
      // code that predates them (12 set-state-in-effect, 1 immutability).
      // Clearing them means reworking those effects, which is its own change —
      // so they stay visible as warnings rather than blocking CI on debt that
      // arrived with the rule. Drop these overrides once the effects are fixed;
      // `npx eslint .` lists every one.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
    },
  },
];
