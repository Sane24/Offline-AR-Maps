//
//  ContentView.swift
//  TrailSight
//
//  Mode switcher: Map (placeholder card until the MapLibre layer ships),
//  3D Preview (placeholder with elevation profiles), and AR navigation.
//  AR and the nav engine are fully live; the placeholders explain what is
//  coming and show real region pack data so the tabs are still useful.
//

import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TabView {
            MapPlaceholderView()
                .tabItem { Label("Map", systemImage: "map") }
            Preview3DPlaceholderView()
                .tabItem { Label("3D", systemImage: "cube.transparent") }
            ARTabView()
                .tabItem { Label("AR", systemImage: "arkit") }
        }
    }
}

// MARK: - AR tab

/// Hosts the route picker, then the AR session with its HUD overlay.
struct ARTabView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if !ARNavigationView.isSupported {
                UnsupportedARView()
            } else if let selection = model.selection {
                ZStack {
                    ARNavigationView(
                        route: selection.prepared,
                        terrain: selection.terrain,
                        pois: model.region?.pois ?? [],
                        session: model.navSession,
                        location: model.location
                    )
                    .ignoresSafeArea()

                    HudView(
                        route: selection.prepared,
                        session: model.navSession,
                        location: model.location,
                        onEnd: { model.endNavigation() }
                    )

                    if model.location.permission == .denied {
                        PermissionDeniedView()
                    }
                }
            } else if let region = model.region {
                RoutePickerView(region: region) { meta in
                    model.start(route: meta)
                }
            } else if let error = model.loadError {
                ContentUnavailableView(
                    "Region failed to load",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
            } else {
                ProgressView("Loading region pack")
            }
        }
    }
}

/// Shown in the simulator or on devices without world tracking.
struct UnsupportedARView: View {
    var body: some View {
        ContentUnavailableView(
            "AR not available",
            systemImage: "camera.metering.unknown",
            description: Text("World tracking AR requires a physical device with a rear camera. Run TrailSight on an iPhone to navigate.")
        )
    }
}

/// Full-screen prompt when location permission was denied.
struct PermissionDeniedView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "location.slash.fill")
                .font(.largeTitle)
            Text("Location access is off")
                .font(.headline)
            Text("TrailSight needs your position to anchor the trail in AR. Enable location for TrailSight in Settings.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(20)
        .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 16))
        .padding(30)
    }
}

// MARK: - Map tab placeholder

/// Region info card plus pack downloads. The interactive 2D map (MapLibre
/// Native) is the next milestone; AR navigation works today.
struct MapPlaceholderView: View {
    @Environment(AppModel.self) private var model
    @State private var baseURLDraft = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    banner

                    if let region = model.region {
                        regionCard(region)
                    }

                    downloadsCard
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Map")
        }
    }

    private var banner: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("2D map ships next; AR + nav are live", systemImage: "hammer")
                .font(.headline)
            Text("The offline vector map (trails, contours, hillshade) arrives with the MapLibre layer. Until then, use the AR tab: routing, snapping, and guidance already run fully offline.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private func regionCard(_ region: RegionData) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(region.manifest.name)
                .font(.headline)
            Text(region.manifest.blurb)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            let bbox = region.manifest.bbox
            Group {
                row("square.dashed", String(format: "%.3f, %.3f to %.3f, %.3f", bbox.south, bbox.west, bbox.north, bbox.east))
                row("point.3.connected.trianglepath.dotted", "\(region.manifest.routes.count) routes, \(region.pois.count) points of interest")
                row("internaldrive", Fmt.bytes(region.manifest.bytes) + " on device")
                row("mountain.2", "Terrain grid \(region.terrain.w) x \(region.terrain.h)")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Text(region.manifest.attribution)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    private func row(_ symbol: String, _ text: String) -> some View {
        Label(text, systemImage: symbol)
    }

    private var downloadsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Region packs")
                .font(.headline)

            ForEach(model.regions.catalog?.regions ?? []) { region in
                downloadRow(region)
            }

            if model.regions.catalog == nil {
                Text("Catalog unavailable")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Pack server")
                    .font(.caption.weight(.semibold))
                HStack {
                    TextField("https://server/data", text: $baseURLDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Save") {
                        model.regions.setBaseURL(baseURLDraft)
                    }
                    .font(.caption.weight(.semibold))
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .onAppear { baseURLDraft = model.regions.baseURLString }
    }

    @ViewBuilder
    private func downloadRow(_ region: CatalogRegion) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(region.name)
                    .font(.subheadline.weight(.medium))
                Text("\(region.routes.count) routes, \(Fmt.bytes(region.bytes))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let error = model.regions.lastError[region.id] {
                    Text(error)
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
            }
            Spacer()
            if region.id == RegionStore.bundledRegionID {
                Label("Bundled", systemImage: "checkmark.seal.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.green)
            } else if let progress = model.regions.progress[region.id] {
                ProgressView(value: progress.fraction)
                    .frame(width: 90)
            } else if model.regions.downloaded[region.id] != nil {
                Button(role: .destructive) {
                    model.regions.delete(id: region.id)
                } label: {
                    Image(systemName: "trash")
                }
            } else {
                Button {
                    let id = region.id
                    Task { await model.regions.download(id: id) }
                } label: {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.title3)
                }
            }
        }
    }
}

// MARK: - 3D preview tab placeholder

/// Elevation profiles per route until the interactive 3D terrain preview
/// (already in the web demo) lands on iOS.
struct Preview3DPlaceholderView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("3D terrain preview ships next", systemImage: "cube.transparent")
                            .font(.headline)
                        Text("The web demo already renders the terrain grid in 3D. On iOS the same TER1 grids power AR path heights today; a flyover preview is planned. Elevation profiles below come from the live route data.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))

                    if let region = model.region {
                        ForEach(region.manifest.routes) { meta in
                            profileCard(region: region, meta: meta)
                        }
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("3D Preview")
        }
    }

    @ViewBuilder
    private func profileCard(region: RegionData, meta: RouteMeta) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(meta.name)
                .font(.subheadline.weight(.semibold))
            if let data = region.routes[meta.id], let prepared = PreparedRoute(data) {
                ElevationProfileView(route: prepared, progress: 0)
                    .frame(height: 64)
                HStack {
                    Text(Fmt.dist(meta.stats.lengthM))
                    Text("+" + Fmt.ele(meta.stats.gainM))
                    Text("\(Int(meta.stats.minEle)) to \(Int(meta.stats.maxEle)) m")
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }
}
