const {
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withXcodeProject,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const WIDGET_NAME = 'QuickExWidget';
const APP_GROUP = 'group.to.quickex.app';

function writeFile(projectRoot, relativePath, contents) {
  const filePath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function withAndroidWidget(config) {
  config = withAndroidManifest(config, (current) => {
    const application = current.modResults.manifest.application[0];
    application.receiver = application.receiver || [];
    if (!application.receiver.some((item) => item.$['android:name'] === '.QuickExWidgetProvider')) {
      application.receiver.push({
        $: {
          'android:name': '.QuickExWidgetProvider',
          'android:exported': 'true',
          'android:label': 'QuickEx',
        },
        'intent-filter': [{
          action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }],
        }],
        'meta-data': [{
          $: {
            'android:name': 'android.appwidget.provider',
            'android:resource': '@xml/quickex_widget_info',
          },
        }],
      });
    }
    return current;
  });

  return withDangerousMod(config, ['android', async (current) => {
    const packageName = current.android.package || 'to.quickex.app';
    const packagePath = packageName.replace(/\./g, '/');
    const root = current.modRequest.platformProjectRoot;
    writeFile(root, `app/src/main/java/${packagePath}/QuickExWidgetProvider.kt`, androidWidgetSource(packageName));
    writeFile(root, 'app/src/main/res/layout/quickex_widget.xml', androidWidgetLayout());
    writeFile(root, 'app/src/main/res/xml/quickex_widget_info.xml', androidWidgetInfo());
    writeFile(root, 'app/src/main/res/drawable/quickex_widget_background.xml', androidWidgetBackground());
    return current;
  }]);
}

function withIosWidget(config) {
  config = withEntitlementsPlist(config, (current) => {
    current.modResults['com.apple.security.application-groups'] = [APP_GROUP];
    return current;
  });

  config = withDangerousMod(config, ['ios', async (current) => {
    const root = current.modRequest.platformProjectRoot;
    writeFile(root, `${WIDGET_NAME}/${WIDGET_NAME}.swift`, iosWidgetSource());
    writeFile(root, `${WIDGET_NAME}/Info.plist`, iosWidgetInfo());
    writeFile(root, `${WIDGET_NAME}/${WIDGET_NAME}.entitlements`, iosWidgetEntitlements());
    return current;
  }]);

  return withXcodeProject(config, (current) => {
    const project = current.modResults;
    const bundleIdentifier = `${current.ios.bundleIdentifier || 'to.quickex.app'}.widget`;
    if (project.pbxTargetByName(WIDGET_NAME)) return current;

    const target = project.addTarget(WIDGET_NAME, 'com.apple.product-type.app-extension', WIDGET_NAME, bundleIdentifier);
    const group = project.addPbxGroup([], WIDGET_NAME, WIDGET_NAME);
    project.addToPbxGroup(group, project.getFirstProject().firstProject.mainGroup);
    const swiftFile = project.addFile(`${WIDGET_NAME}/${WIDGET_NAME}.swift`, group, { target: target.uuid });
    project.addBuildPhase([swiftFile], 'PBXSourcesBuildPhase', target.uuid);
    project.addFile(`${WIDGET_NAME}/Info.plist`, group);
    project.addFile(`${WIDGET_NAME}/${WIDGET_NAME}.entitlements`, group, { target: target.uuid });
    project.addTargetDependency(project.getFirstTarget().uuid, target.uuid);
    const configurations = project.pbxXCBuildConfigurationSection();
    Object.keys(configurations).forEach((key) => {
      const settings = configurations[key].buildSettings;
      if (settings && settings.PRODUCT_BUNDLE_IDENTIFIER === bundleIdentifier) {
        settings.SWIFT_VERSION = '5.0';
        settings.IPHONEOS_DEPLOYMENT_TARGET = '17.0';
        settings.INFOPLIST_FILE = `${WIDGET_NAME}/Info.plist`;
        settings.CODE_SIGN_ENTITLEMENTS = `${WIDGET_NAME}/${WIDGET_NAME}.entitlements`;
        settings.TARGETED_DEVICE_FAMILY = '1,2';
        settings.GENERATE_INFOPLIST_FILE = 'NO';
      }
    });
    return current;
  });
}

module.exports = function withHomeScreenWidgets(config) {
  return withIosWidget(withAndroidWidget(config));
};

function androidWidgetSource(packageName) {
  return `package ${packageName}

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

class QuickExWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { id ->
      val views = RemoteViews(context.packageName, R.layout.quickex_widget)
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      views.setOnClickPendingIntent(R.id.quickex_widget_root, pending)
      manager.updateAppWidget(id, views)
    }
  }
}
`;
}

function androidWidgetLayout() {
  return `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:id="@+id/quickex_widget_root" android:layout_width="match_parent" android:layout_height="match_parent" android:orientation="vertical" android:gravity="center_vertical" android:padding="16dp" android:background="@drawable/quickex_widget_background"><TextView android:id="@+id/quickex_widget_title" android:layout_width="wrap_content" android:layout_height="wrap_content" android:text="QuickEx" android:textColor="#FFFFFF" android:textSize="18sp" android:textStyle="bold"/><TextView android:id="@+id/quickex_widget_message" android:layout_width="wrap_content" android:layout_height="wrap_content" android:layout_marginTop="6dp" android:text="Open to view payments" android:textColor="#B8D0C8" android:textSize="13sp"/></LinearLayout>\n`;
}

function androidWidgetInfo() {
  return `<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android" android:minWidth="180dp" android:minHeight="80dp" android:updatePeriodMillis="1800000" android:initialLayout="@layout/quickex_widget" android:resizeMode="horizontal|vertical" android:widgetCategory="home_screen" />\n`;
}

function androidWidgetBackground() {
  return `<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle"><solid android:color="#12231F"/><corners android:radius="16dp"/><padding android:left="16dp" android:top="14dp" android:right="16dp" android:bottom="14dp"/></shape>\n`;
}

function iosWidgetSource() {
  return `import SwiftUI
import WidgetKit

struct QuickExWidgetEntry: TimelineEntry { let date: Date }
struct QuickExWidgetProvider: TimelineProvider {
  func placeholder(in context: Context) -> QuickExWidgetEntry { QuickExWidgetEntry(date: Date()) }
  func getSnapshot(in context: Context, completion: @escaping (QuickExWidgetEntry) -> Void) { completion(QuickExWidgetEntry(date: Date())) }
  func getTimeline(in context: Context, completion: @escaping (Timeline<QuickExWidgetEntry>) -> Void) {
    let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
    completion(Timeline(entries: [QuickExWidgetEntry(date: Date())], policy: .after(next)))
  }
}
struct QuickExWidgetView: View {
  var entry: QuickExWidgetProvider.Entry
  var body: some View {
    Link(destination: URL(string: "quickex://")!) {
      VStack(alignment: .leading, spacing: 8) {
        Text("QuickEx").font(.headline).foregroundStyle(.white)
        Text("Open to view payments").font(.subheadline).foregroundStyle(.white.opacity(0.75))
        Text(entry.date, style: .time).font(.caption).foregroundStyle(.white.opacity(0.55))
      }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }.containerBackground(Color(red: 0.07, green: 0.14, blue: 0.12), for: .widget)
  }
}
@main struct QuickExWidget: Widget {
  var body: some WidgetConfiguration { StaticConfiguration(kind: "QuickExWidget", provider: QuickExWidgetProvider()) { entry in QuickExWidgetView(entry: entry) }.configurationDisplayName("QuickEx").description("Open QuickEx to view payment activity.").supportedFamilies([.systemSmall, .systemMedium]) }
}
`;
}

function iosWidgetInfo() {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>NSExtension</key><dict><key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string><key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).QuickExWidget</string></dict></dict></plist>\n`;
}

function iosWidgetEntitlements() {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.application-groups</key><array><string>${APP_GROUP}</string></array></dict></plist>\n`;
}