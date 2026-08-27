# TrailSight iOS

Offline-first AR trail navigation for rocky, featureless terrain. This is the native iOS counterpart of the TrailSight web demo in `../web`. It consumes the exact same region pack format (manifest, route JSON, TER1 terrain grids) and ports the same navigation engine, so both clients agree on snapping, guidance, and ETA to the meter.

## What works today

- AR navigation: chevrons hugging the terrain along the next 300 m of trail, a pulsing beacon ring and light beam at the next waypoint, billboard labels for named landmarks and POIs.
- Full offline navigation engine: route snapping, off-route detection with hysteresis, arrival detection, remaining distance and climb, hiking ETA, human guidance strings. Identical semantics to the web engine.
- Bundled demo region (Joshua Tree: Ryan Mountain and Boy Scout Trail), fully usable with no network.
- Region pack downloads from a configurable pack server into Application Support, with progress, tracked in a UserDefaults registry.
- The Map tab is a placeholder card for now: 2D map ships next; AR + nav are live. MapLibre Native via Swift Package Manager is the intended map layer.

## Build and run

Requirements: a Mac with Xcode 15 or newer, and a physical iPhone. Camera and ARKit do not work in the simulator; the app builds and launches there, but the AR tab shows an unsupported notice.

1. Install XcodeGen and generate the project:

   ```sh
   brew install xcodegen
   cd ios
   xcodegen generate
   ```

2. Open `TrailSight.xcodeproj` in Xcode.
3. Select the TrailSight target, then Signing & Capabilities, and pick your development team. The bundle id is `com.trailsight.app`; change it if your team cannot sign that id.
4. Select your iPhone as the run destination (not a simulator) and press Run.
5. On first launch, accept the camera and location permission prompts. Walk outside with a clear sky view; the session locks its geographic origin on the first GPS fix better than 25 m.

To try the demo trails far from Joshua Tree, the nav engine will simply report you off route; the AR content still renders relative to your position, several kilometers away. Real field testing should happen on trails inside a loaded region.

## Architecture overview

```
TrailSight/
  App/       TrailSightApp (app state), ContentView (Map / 3D / AR tabs)
  Core/      Geo (LonLat, haversine, bearing, LocalFrame ENU)
             TerrainGrid (TER1 decoder, mercator-y bilinear sampler, line of sight)
             Route (Codable pack models, PreparedRoute with snap and along-route sampling)
             NavEngine (pure functional nav state + guidance strings)
             RegionStore (bundled pack loading, downloads, registry)
  Sensors/   LocationService (CLLocationManager: authorization, GPS, compass)
  AR/        ARNavigationView (ARView wrapper, entity building, re-anchoring)
  UI/        HudView (compass tape, guidance banner, stats, elevation profile)
             RoutePickerView (route cards with stats and Start)
Resources/
  DemoRegion/  the joshua-tree region pack, bundled as a folder reference
  catalog.json region catalog, same file the web app serves
```

### The AR coordinate approach

The AR session runs `ARWorldTrackingConfiguration` with `worldAlignment = .gravityAndHeading`. That makes ARKit world axes metric and geo-referenced: +X points east, +Y up, and -Z true north. Geographic content is placed by converting lon/lat into a local East-North-Up frame centered on a session origin: the phone's position at the moment the first good GPS fix arrives. ENU offsets map to AR space as (x: east, y: up, z: -north). Elevations come from the route's high resolution TER1 terrain patch, sampled bilinearly with web mercator y interpolation, exactly like the web sampler, so chevrons hug the real ground.

GPS drift is corrected without restarting the session: every nav tick the coordinator compares where GPS says the phone is against where the AR frame thinks it is. When the horizontal gap exceeds 8 m, the root geo anchor is translated smoothly (a 1 s eased move) so the world snaps back into agreement. Tracking, rendering, and the user's sense of the scene never hitch.

### Graceful degradation when the compass is poor

`gravityAndHeading` depends on the magnetometer at session start, and iron-rich rock or a magnetic phone mount can skew it. TrailSight handles this in layers:

- ARKit continually refines its north alignment as you move; small initial errors wash out.
- `LocationService` watches `CLHeading.headingAccuracy`. When it is worse than 25 degrees the HUD shows a calibration hint (wave the phone in a figure eight). This does not interrupt the session.
- Guidance text never depends on AR alignment: snapping, distances, bearings, and instructions are computed from GPS plus route geometry alone, so even with a badly rotated AR overlay the banner ("Bear right in 40 m", "Off trail by 60 m, head NE") remains correct.
- If the AR session is interrupted (phone call, backgrounding), the origin is dropped and re-locked on the next good fix with a fresh heading alignment.

### Region packs

Same layout the web app serves from `web/public/data`:

- `catalog.json`: list of regions with ids, names, bboxes, route summaries.
- `regions/<id>/manifest.json`: files map (trails, pois, contours, hillshade, terrain), route metadata with stats and AR patch info, attribution.
- `regions/<id>/routes/<route>.json`: `id`, `name`, `blurb`, `coords` as `[lon, lat, ele]` triples resampled at about 12 m, `cum` cumulative meters, `waypoints` (`i`, `kind`, `name?`, `instruction`, `dir?`), `stats`, `arPatch`.
- Terrain `.bin` (TER1, little endian): magic `TER1`, uint32 w, uint32 h, four float64 bounds (west, south, east, north), then w*h int16 elevation meters, row 0 at the north edge, rows spaced equally in web mercator y.

The bundle ships the demo region without `contours.geojson` and `hillshade.png` to stay small; those files matter only to the 2D map layer. Downloads fetch everything the manifest lists. The pack server base URL is configurable on the Map tab; packs are stored under Application Support/TrailSight/regions and survive app updates.

## App Store submission checklist

1. Bump `MARKETING_VERSION` (and `CURRENT_PROJECT_VERSION` per upload) in `project.yml`, regenerate, and confirm the app icon set has a 1024 pt icon (add artwork to `Resources/Assets.xcassets/AppIcon.appiconset`).
2. In Xcode: Product > Archive with Any iOS Device (arm64) selected, then Distribute App > App Store Connect > Upload. Automatic signing with your distribution certificate is fine.
3. In App Store Connect, create the app record with bundle id `com.trailsight.app`, attach the build, and fill screenshots (6.7 inch and 6.1 inch required) showing the AR view outdoors.
4. Privacy nutrition labels: declare Location (Precise Location, used for App Functionality, not linked to identity, not used for tracking). Camera frames are processed on device by ARKit and never collected or transmitted; if you add no analytics, declare "Data Not Collected" for everything else. Motion data likewise stays on device.
5. Export compliance: the app uses only standard OS encryption (HTTPS). `ITSAppUsesNonExemptEncryption` is already `false` in the Info.plist, so no yearly self-classification report is normally required for it.
6. App Review notes: state that the app requires an iPhone with ARKit, outdoor GPS, and that reviewers can exercise the AR tab anywhere (the app will show off-route guidance toward the demo region). Include a short demo video link if review has trouble reproducing outdoor use.
7. Age rating questionnaire: no sensitive content. Category: Navigation. Set the `UIRequiredDeviceCapabilities` arkit entry (already in the plist) so the store hides the app from unsupported devices.
8. TestFlight a build on at least two device generations outdoors before submitting: verify origin lock, re-anchoring while walking, and battery drain on a full route.

## Roadmap notes

- MapLibre Native (SPM package `maplibre/maplibre-gl-native-distribution`) will render the offline vector trails, contours, and hillshade already shipped in region packs.
- A 3D flyover preview using the same TER1 grids (SceneKit or RealityKit orthographic) replaces the 3D tab placeholder.
- Barometric altitude fusion (CMAltimeter) can stabilize elevation between GPS fixes; the Pose struct already carries `ele` separately for this.
