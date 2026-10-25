/**
 * Backport expo/expo#45063 to expo-camera 55.0.10:
 * https://github.com/expo/expo/pull/45063
 *
 * A dismissed VisionKit scanner remains retained and can leave the iOS camera
 * indicator active after backgrounding/foregrounding. Observe interactive
 * dismissal as well as dismissScanner(), stop scanning, and release the context.
 * Force this pod to compile from source so precompiled binaries cannot bypass
 * the backport on EAS Build.
 * This changes native Swift code and requires a new iOS build to reach devices.
 */
const fs = require('node:fs');
const path = require('node:path');

const replacements = new Map([
    ['ios/ExpoCamera.podspec', [
        [`  if !$ExpoUseSources&.include?(package['name']) && ENV['EXPO_USE_SOURCE'].to_i == 0 && File.exist?("#{s.name}.xcframework") && Gem::Version.new(Pod::VERSION) >= Gem::Version.new('1.10.0')
    s.source_files = "**/*.h"
    s.vendored_frameworks = "#{s.name}.xcframework"
  else
    s.source_files = "**/*.{h,m,swift}"
  end`,
        `  # Happy backports the scanner dismissal fix; compile the patched Swift sources.
  s.source_files = "**/*.{h,m,swift}"`],
    ]],
    ['ios/CameraViewModule.swift', [
        [`    appContext?.utilities?.currentViewController()?.present(controller, animated: true) {
      try? controller.startScanning()
    }`,
        `    appContext?.utilities?.currentViewController()?.present(controller, animated: true) { [weak self] in
      if let delegate = self?.scannerContext?.delegate as? VisionScannerDelegate {
        controller.presentationController?.delegate = delegate
      }
      try? controller.startScanning()
    }`],
        [`    controller.stopScanning()
    controller.dismiss(animated: true)
  }

  func onItemScanned(result: [String: Any]) {
    sendEvent("onModernBarcodeScanned", result)
  }

  private func getAvailableVideoCodecs() -> [String] {`,
        `    controller.dismiss(animated: true) { [weak self] in
      self?.onScannerDismissed()
    }
  }

  func onItemScanned(result: [String: Any]) {
    sendEvent("onModernBarcodeScanned", result)
  }

  @MainActor
  func onScannerDismissed() {
    if #available(iOS 16.0, *) {
      if let controller = scannerContext?.controller as? DataScannerViewController {
        controller.stopScanning()
      }
    }
    scannerContext = nil
  }

  private func getAvailableVideoCodecs() -> [String] {`],
    ]],
    ['ios/Current/VisionScannerDelegate.swift', [
        [`protocol ScannerResultHandler {
  func onItemScanned(result: [String: Any])
}`,
        `protocol ScannerResultHandler {
  func onItemScanned(result: [String: Any])
  @MainActor func onScannerDismissed()
}`],
        ['class VisionScannerDelegate: NSObject, DataScannerViewControllerDelegate {',
        'class VisionScannerDelegate: NSObject, DataScannerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {'],
        [`    }
  }
}
`,
        `    }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    handler.onScannerDismissed()
  }
}
`],
    ]],
]);

function patchSource(source, edits, relative) {
    if (edits.every(([, after]) => source.split(after).length === 2)) return source;
    for (const [before, after] of edits) {
        if (source.split(before).length !== 2 || source.includes(after)) {
            throw new Error(`[patch] Unexpected expo-camera source in ${relative}; review fix-expo-camera-scanner-dismissal.cjs`);
        }
    }
    for (const [before, after] of edits) source = source.replace(before, after);
    return source;
}

function patchExpoCameraScannerDismissal(nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
]) {
    const packageRoots = new Set();
    for (const root of nodeModulesRoots) {
        const packageRoot = path.join(root, 'expo-camera');
        if (fs.existsSync(path.join(packageRoot, 'package.json'))) {
            packageRoots.add(fs.realpathSync(packageRoot));
        }
    }

    const changes = new Map();
    for (const packageRoot of packageRoots) {
        for (const [relative, edits] of replacements) {
            const file = path.join(packageRoot, relative);
            const source = fs.readFileSync(file, 'utf8');
            const patched = patchSource(source, edits, relative);
            if (patched !== source) changes.set(file, patched);
        }
    }
    // Validate the podspec and both Swift files in every copy before writing any.
    for (const [file, source] of changes) fs.writeFileSync(file, source);
    if (changes.size) console.log(`[patch] Fixed expo-camera iOS scanner dismissal (${changes.size} file(s))`);
    return { installed: packageRoots.size, changed: changes.size };
}

module.exports = { patchExpoCameraScannerDismissal };
if (require.main === module) patchExpoCameraScannerDismissal();
