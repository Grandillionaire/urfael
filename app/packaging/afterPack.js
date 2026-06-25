// Ad-hoc sign the packaged macOS app so it ships with a VALID code signature.
//
// We do not have an Apple Developer ID in CI, so electron-builder skips its signing
// step (CSC_IDENTITY_AUTO_DISCOVERY=false). That leaves the app with only the linker's
// partial ad-hoc signature and no sealed resources, which Apple Silicon macOS rejects
// outright as "Urfael is damaged / can't be opened". Applying a clean ad-hoc signature
// here produces a signature that the kernel accepts, downgrading that hard block to the
// ordinary "unidentified developer" prompt a user can get past.
//
// This is NOT notarization. A frictionless, warning-free open still requires a Developer
// ID signature plus notarization. This is the best we can do without an Apple Developer
// account, and it is strictly better than shipping an unopenable app.
//
// NOTE: this lives in packaging/ rather than build/ on purpose, build/ is gitignored, so
// a hook placed there would never reach CI and the release would ship unsigned again.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename; // "Urfael"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`afterPack: ad-hoc signing ${appPath}`);
  // --deep recursively signs the nested Electron frameworks and helpers, then the outer
  // bundle, sealing resources so the signature is internally consistent.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log('afterPack: ad-hoc signature applied and verified');
};
