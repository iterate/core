// React Doctor's settings for the config repos in this folder (`default`, `minimal`). It is beside
// them and not in them: a config folder is copied whole into a mind, and a mind's repo needs no
// tool's settings. React Doctor reads the settings of the nearest folder above the one it scans:
//
//   cd core/configs/default && npx react-doctor@latest --yes --verbose --no-score .
export default {
  ignore: {
    overrides: [
      // A NO-BUILD APP'S PAGE SCRIPT RUNS IN A BROWSER AND NOWHERE ELSE. Nothing renders it on a
      // server, so a global read while it draws or at its top has no server to fail on, and a
      // date in the visitor's own locale is the point. Nothing bundles it either, so an import of
      // an address made at run time (the Voice app's pinned build) costs no code split.
      {
        files: ["apps/*/public/**", "apps/live-reload/**"],
        rules: [
          "react-doctor/no-unguarded-browser-global-in-render-or-hook-init",
          "react-doctor/no-unguarded-browser-global-at-module-scope",
          "react-doctor/no-locale-format-in-render",
          "react-doctor/no-dynamic-import-path",
        ],
      },
    ],
  },
};
