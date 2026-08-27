//
//  RegionStore.swift
//  TrailSight
//
//  Offline region packs. The pack layout is identical to the web app:
//  a manifest.json listing files (trails, pois, terrain, per-route AR
//  patches) plus routes/<id>.json route files. The demo region ships inside
//  the app bundle; additional regions download from a configurable base URL
//  into Application Support using URLSession download tasks. A small
//  registry in UserDefaults tracks what is fully downloaded, mirroring the
//  web app's localStorage registry.
//

import Foundation
import Observation

// MARK: - Pack manifest models (match the JSON exactly)

/// Geographic bounding box as stored in manifests and the catalog.
public struct BBox: Codable, Sendable {
    public let south: Double
    public let west: Double
    public let north: Double
    public let east: Double
}

/// One entry in a manifest's `files` map. Terrain and hillshade entries
/// carry extra geo metadata; those fields decode as optionals.
public struct ManifestFile: Codable, Sendable {
    public let path: String
    public let bytes: Int
    public let w: Int?
    public let h: Int?
    public let west: Double?
    public let south: Double?
    public let east: Double?
    public let north: Double?
}

/// Grid metadata for a route's AR terrain patch.
public struct PatchMeta: Codable, Sendable {
    public let w: Int
    public let h: Int
    public let west: Double
    public let south: Double
    public let east: Double
    public let north: Double
    public let bytes: Int
}

/// Route summary inside a region manifest.
public struct RouteMeta: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let blurb: String
    /// Relative path of the route JSON, e.g. "routes/ryan-mountain.json".
    public let file: String
    /// Relative path of the high resolution AR terrain patch.
    public let arPatch: String
    public let patchMeta: PatchMeta?
    public let stats: RouteStats
    /// Trailhead as [lon, lat].
    public let start: [Double]
    public let bytes: Int
}

/// A region pack manifest, `manifest.json` at the pack root.
public struct RegionManifest: Codable, Sendable {
    public let id: String
    public let name: String
    public let blurb: String
    public let version: Int
    public let bbox: BBox
    /// [lon, lat].
    public let center: [Double]
    public let attribution: String
    public let files: [String: ManifestFile]
    public let routes: [RouteMeta]
    public let bytes: Int
}

/// Catalog of all known regions, `catalog.json`.
public struct CatalogRouteRef: Codable, Sendable {
    public let id: String
    public let name: String
    public let km: Double
}

public struct CatalogRegion: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let blurb: String
    public let center: [Double]
    public let bbox: BBox
    public let bytes: Int
    public let routes: [CatalogRouteRef]
}

public struct Catalog: Codable, Sendable {
    public let regions: [CatalogRegion]
}

// MARK: - POIs (minimal GeoJSON point parsing)

/// A named point feature from the pack's pois.geojson.
public struct PointOfInterest: Sendable {
    public let name: String?
    public let kind: String?
    public let ele: Double?
    public let lon: Double
    public let lat: Double

    public var lonLat: LonLat { LonLat(lon: lon, lat: lat) }
}

/// Tolerant GeoJSON decoding: only Point features are kept, everything
/// else is skipped rather than failing the whole file.
private struct GeoFeatureCollection: Decodable {
    let features: [GeoFeature]
}

private struct GeoFeature: Decodable {
    let properties: GeoProperties?
    let geometry: GeoGeometry?
}

private struct GeoProperties: Decodable {
    let kind: String?
    let name: String?
    let ele: Double?

    private enum CodingKeys: String, CodingKey {
        case kind, name, ele
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        if let s = try? c.decodeIfPresent(String.self, forKey: .name) {
            name = s
        } else if let n = try? c.decodeIfPresent(Double.self, forKey: .name) {
            name = String(Int(n))
        } else {
            name = nil
        }
        if let e = try? c.decodeIfPresent(Double.self, forKey: .ele) {
            ele = e
        } else {
            ele = nil
        }
    }
}

private struct GeoGeometry: Decodable {
    let type: String
    /// Present only for Point geometries.
    let point: [Double]?

    private enum CodingKeys: String, CodingKey {
        case type, coordinates
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        if type == "Point" {
            point = try? c.decode([Double].self, forKey: .coordinates)
        } else {
            point = nil
        }
    }
}

// MARK: - Loaded region

/// Everything the app needs from one region pack, fully decoded.
public struct RegionData {
    public let manifest: RegionManifest
    public let terrain: TerrainGrid
    public let routes: [String: RouteData]
    /// High resolution AR patches keyed by route id. Falls back to the
    /// region terrain when a patch is missing, like the web loader.
    public let patches: [String: TerrainGrid]
    public let pois: [PointOfInterest]

    /// The best available terrain for a route's AR session.
    public func patchOrTerrain(for routeID: String) -> TerrainGrid {
        patches[routeID] ?? terrain
    }
}

// MARK: - Errors

public enum RegionStoreError: Error, LocalizedError {
    case missingBundleResource(String)
    case missingFile(String)
    case missingManifestEntry(String)
    case badBaseURL(String)
    case httpStatus(Int)
    case downloadIncomplete
    case badRoute(String)

    public var errorDescription: String? {
        switch self {
        case .missingBundleResource(let name):
            return "Bundled resource not found: \(name)"
        case .missingFile(let path):
            return "Region file not found: \(path)"
        case .missingManifestEntry(let key):
            return "Manifest is missing the \(key) entry"
        case .badBaseURL(let s):
            return "Invalid region server URL: \(s)"
        case .httpStatus(let code):
            return "Server returned HTTP \(code)"
        case .downloadIncomplete:
            return "Download did not complete"
        case .badRoute(let id):
            return "Route \(id) is malformed"
        }
    }
}

// MARK: - Registry and progress

/// One downloaded region as recorded in UserDefaults.
public struct RegionRegistryEntry: Codable, Sendable {
    public let version: Int
    public let bytes: Int
    /// Seconds since 1970 at download completion.
    public let at: Double
}

/// Live progress of one region download.
public struct DownloadProgress: Sendable {
    public var bytesDone: Int64
    public var bytesTotal: Int64

    public var fraction: Double {
        bytesTotal > 0 ? Double(bytesDone) / Double(bytesTotal) : 0
    }
}

// MARK: - File downloader (URLSession download tasks with progress)

/// Sequentially downloads files to explicit destinations using
/// URLSession download tasks, reporting byte progress per file.
final class FileDownloader: NSObject, URLSessionDownloadDelegate {
    private struct Handler {
        let destination: URL
        let onProgress: (Int64, Int64) -> Void
        var continuation: CheckedContinuation<Void, Error>?
        var moved = false
        var moveError: Error?
    }

    private var handlers: [Int: Handler] = [:]
    private let lock = NSLock()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }()

    /// Downloads one file. Throws on network errors, non-2xx status, or
    /// filesystem failures while moving the temp file into place.
    func download(from url: URL, to destination: URL, onProgress: @escaping (Int64, Int64) -> Void) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let task = session.downloadTask(with: url)
            lock.lock()
            handlers[task.taskIdentifier] = Handler(destination: destination, onProgress: onProgress, continuation: cont)
            lock.unlock()
            task.resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        lock.lock()
        let handler = handlers[downloadTask.taskIdentifier]
        lock.unlock()
        handler?.onProgress(totalBytesWritten, totalBytesExpectedToWrite)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        lock.lock()
        guard var handler = handlers[downloadTask.taskIdentifier] else {
            lock.unlock()
            return
        }
        lock.unlock()

        do {
            if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw RegionStoreError.httpStatus(http.statusCode)
            }
            let fm = FileManager.default
            try fm.createDirectory(
                at: handler.destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if fm.fileExists(atPath: handler.destination.path) {
                try fm.removeItem(at: handler.destination)
            }
            try fm.moveItem(at: location, to: handler.destination)
            handler.moved = true
        } catch {
            handler.moveError = error
        }

        lock.lock()
        handlers[downloadTask.taskIdentifier] = handler
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let handler = handlers.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let handler, let cont = handler.continuation else { return }
        if let error {
            cont.resume(throwing: error)
        } else if let moveError = handler.moveError {
            cont.resume(throwing: moveError)
        } else if handler.moved {
            cont.resume(returning: ())
        } else {
            cont.resume(throwing: RegionStoreError.downloadIncomplete)
        }
    }
}

// MARK: - RegionStore

/// Source of truth for region packs: the bundled demo region, downloaded
/// regions on disk, the catalog, and download progress. UI observes this
/// directly; all mutations land on the main thread.
@Observable
public final class RegionStore {
    /// The region shipped inside the app bundle.
    public static let bundledRegionID = "joshua-tree"
    /// Bundle subdirectory holding the demo pack (a folder reference).
    public static let bundledFolderName = "DemoRegion"

    private static let registryKey = "trailsight.regions.v1"
    private static let baseURLKey = "trailsight.baseurl"
    private static let defaultBaseURL = "https://packs.trailsight.example.com/data"

    /// Known regions, from the bundled catalog and optionally refreshed
    /// over the network.
    public private(set) var catalog: Catalog?
    /// Registry of fully downloaded regions.
    public private(set) var downloaded: [String: RegionRegistryEntry] = [:]
    /// Live download progress per region id.
    public private(set) var progress: [String: DownloadProgress] = [:]
    /// Last download error message per region id, for the UI.
    public private(set) var lastError: [String: String] = [:]
    /// Server that hosts region packs, layout `<base>/regions/<id>/<path>`.
    public private(set) var baseURLString: String

    private let downloader = FileDownloader()

    public init() {
        let defaults = UserDefaults.standard
        baseURLString = defaults.string(forKey: RegionStore.baseURLKey) ?? RegionStore.defaultBaseURL
        if let data = defaults.data(forKey: RegionStore.registryKey),
           let reg = try? JSONDecoder().decode([String: RegionRegistryEntry].self, from: data) {
            downloaded = reg
        }
    }

    /// Updates and persists the pack server base URL.
    public func setBaseURL(_ s: String) {
        baseURLString = s
        UserDefaults.standard.set(s, forKey: RegionStore.baseURLKey)
    }

    /// True when a region can be loaded with the network off.
    public func isAvailableOffline(_ id: String) -> Bool {
        id == RegionStore.bundledRegionID || downloaded[id] != nil
    }

    // MARK: Paths

    /// Application Support/TrailSight, created on demand.
    private func supportDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let dir = base.appendingPathComponent("TrailSight", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// On-disk location for one file of a downloaded region. The relative
    /// layout matches the manifest paths exactly.
    private func fileURL(regionID: String, path: String) throws -> URL {
        try supportDirectory()
            .appendingPathComponent("regions", isDirectory: true)
            .appendingPathComponent(regionID, isDirectory: true)
            .appendingPathComponent(path)
    }

    /// URL of a bundled demo region file, nil if not bundled.
    private func bundleURL(path: String) -> URL? {
        guard let root = Bundle.main.url(forResource: RegionStore.bundledFolderName, withExtension: nil) else {
            return nil
        }
        let url = root.appendingPathComponent(path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Reads one region file, preferring the downloaded copy on disk and
    /// falling back to the app bundle for the demo region.
    private func readRegionFile(regionID: String, path: String) throws -> Data {
        if let disk = try? fileURL(regionID: regionID, path: path),
           FileManager.default.fileExists(atPath: disk.path) {
            return try Data(contentsOf: disk)
        }
        if regionID == RegionStore.bundledRegionID, let url = bundleURL(path: path) {
            return try Data(contentsOf: url)
        }
        throw RegionStoreError.missingFile("\(regionID)/\(path)")
    }

    // MARK: Catalog

    /// Loads the bundled catalog immediately and then tries a silent
    /// network refresh from the pack server.
    public func loadCatalog() async {
        if let url = Bundle.main.url(forResource: "catalog", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let cat = try? JSONDecoder().decode(Catalog.self, from: data) {
            await MainActor.run { self.catalog = cat }
        }
        guard let base = URL(string: baseURLString) else { return }
        let remote = base.appendingPathComponent("catalog.json")
        if let (data, response) = try? await URLSession.shared.data(from: remote),
           let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
           let cat = try? JSONDecoder().decode(Catalog.self, from: data) {
            await MainActor.run { self.catalog = cat }
        }
    }

    // MARK: Loading

    /// Decodes a full region pack from the bundle or from disk. Heavy
    /// decoding runs on the caller's executor, so call from a background
    /// task and hop to the main actor with the result.
    public func loadRegion(id: String) async throws -> RegionData {
        let manifestData = try readRegionFile(regionID: id, path: "manifest.json")
        let manifest = try JSONDecoder().decode(RegionManifest.self, from: manifestData)

        guard let terrainEntry = manifest.files["terrain"] else {
            throw RegionStoreError.missingManifestEntry("terrain")
        }
        let terrain = try TerrainGrid.decode(try readRegionFile(regionID: id, path: terrainEntry.path))

        var routes: [String: RouteData] = [:]
        var patches: [String: TerrainGrid] = [:]
        for meta in manifest.routes {
            let routeData = try readRegionFile(regionID: id, path: meta.file)
            let route = try JSONDecoder().decode(RouteData.self, from: routeData)
            routes[meta.id] = route
            if let patchData = try? readRegionFile(regionID: id, path: meta.arPatch),
               let patch = try? TerrainGrid.decode(patchData) {
                patches[meta.id] = patch
            }
        }

        var pois: [PointOfInterest] = []
        if let poiEntry = manifest.files["pois"],
           let poiData = try? readRegionFile(regionID: id, path: poiEntry.path),
           let collection = try? JSONDecoder().decode(GeoFeatureCollection.self, from: poiData) {
            for feature in collection.features {
                guard let geom = feature.geometry, let pt = geom.point, pt.count >= 2 else { continue }
                pois.append(
                    PointOfInterest(
                        name: feature.properties?.name,
                        kind: feature.properties?.kind,
                        ele: feature.properties?.ele,
                        lon: pt[0],
                        lat: pt[1]
                    )
                )
            }
        }

        return RegionData(manifest: manifest, terrain: terrain, routes: routes, patches: patches, pois: pois)
    }

    // MARK: Downloading

    /// Full file list for a region download, mirroring the web app's
    /// manifestFileList: every manifest file, every route file, and every
    /// AR patch (bytes from patchMeta when the files map lacks an entry).
    private func downloadList(for manifest: RegionManifest) -> [(path: String, bytes: Int)] {
        var files: [(path: String, bytes: Int)] = []
        for f in manifest.files.values {
            files.append((f.path, f.bytes))
        }
        for r in manifest.routes {
            files.append((r.file, r.bytes))
            if manifest.files["patch:\(r.id)"] == nil {
                files.append((r.arPatch, r.patchMeta?.bytes ?? 250_000))
            }
        }
        return files
    }

    /// Downloads a region pack to Application Support with progress,
    /// then records it in the registry. Safe to call again to re-download.
    public func download(id: String) async {
        await MainActor.run {
            self.lastError[id] = nil
            self.progress[id] = DownloadProgress(bytesDone: 0, bytesTotal: 1)
        }
        do {
            guard let base = URL(string: baseURLString) else {
                throw RegionStoreError.badBaseURL(baseURLString)
            }
            let regionBase = base
                .appendingPathComponent("regions", isDirectory: true)
                .appendingPathComponent(id, isDirectory: true)

            // Manifest first; it names everything else.
            let manifestDest = try fileURL(regionID: id, path: "manifest.json")
            try await downloader.download(
                from: regionBase.appendingPathComponent("manifest.json"),
                to: manifestDest,
                onProgress: { _, _ in }
            )
            let manifest = try JSONDecoder().decode(RegionManifest.self, from: Data(contentsOf: manifestDest))

            let files = downloadList(for: manifest)
            let totalBytes = Int64(files.reduce(0) { $0 + $1.bytes })
            var doneBytes: Int64 = 0
            await MainActor.run {
                self.progress[id] = DownloadProgress(bytesDone: 0, bytesTotal: max(totalBytes, 1))
            }

            for file in files {
                let dest = try fileURL(regionID: id, path: file.path)
                let expected = Int64(file.bytes)
                let baseDone = doneBytes
                try await downloader.download(
                    from: regionBase.appendingPathComponent(file.path),
                    to: dest,
                    onProgress: { written, expectedFromServer in
                        let fileTotal = expectedFromServer > 0 ? expectedFromServer : expected
                        let clamped = min(written, fileTotal)
                        let done = baseDone + clamped
                        DispatchQueue.main.async {
                            self.progress[id] = DownloadProgress(
                                bytesDone: min(done, totalBytes),
                                bytesTotal: max(totalBytes, 1)
                            )
                        }
                    }
                )
                doneBytes += expected
            }

            let entry = RegionRegistryEntry(
                version: manifest.version,
                bytes: Int(totalBytes),
                at: Date().timeIntervalSince1970
            )
            await MainActor.run {
                self.downloaded[id] = entry
                self.progress[id] = nil
                self.persistRegistry()
            }
        } catch {
            await MainActor.run {
                self.progress[id] = nil
                self.lastError[id] = error.localizedDescription
            }
        }
    }

    /// Removes a downloaded region from disk and the registry. The bundled
    /// demo region always remains available from the bundle.
    public func delete(id: String) {
        if let dir = try? supportDirectory()
            .appendingPathComponent("regions", isDirectory: true)
            .appendingPathComponent(id, isDirectory: true) {
            try? FileManager.default.removeItem(at: dir)
        }
        downloaded[id] = nil
        persistRegistry()
    }

    private func persistRegistry() {
        if let data = try? JSONEncoder().encode(downloaded) {
            UserDefaults.standard.set(data, forKey: RegionStore.registryKey)
        }
    }
}
