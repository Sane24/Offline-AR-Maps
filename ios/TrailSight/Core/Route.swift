//
//  Route.swift
//  TrailSight
//
//  Route pack model. The Codable structs match the region pack JSON exactly
//  (same field names and shapes as the web app's route.ts), and
//  PreparedRoute mirrors the web prepareRoute: a local planar frame plus
//  precomputed arrays that make snapping and remaining-climb queries cheap.
//

import Foundation

/// Known waypoint kinds. Packs may introduce new kinds, so `Waypoint.kind`
/// stays a raw string and this enum is a best-effort interpretation.
public enum WaypointKind: String, Sendable {
    case start
    case arrive
    case bear
    case turn
    case switchback
    case peak
    case saddle
    case viewpoint
    case water
    case landmark
    case guidepost
}

/// A guidance point attached to a route vertex.
public struct Waypoint: Codable, Sendable {
    /// Index into the route `coords` array.
    public let i: Int
    /// Raw kind string, see `WaypointKind` for known values.
    public let kind: String
    public let name: String?
    public let instruction: String
    /// "left" or "right" for maneuvers.
    public let dir: String?

    public init(i: Int, kind: String, name: String? = nil, instruction: String, dir: String? = nil) {
        self.i = i
        self.kind = kind
        self.name = name
        self.instruction = instruction
        self.dir = dir
    }

    /// Parsed kind, nil for kinds this build does not know about.
    public var kindValue: WaypointKind? { WaypointKind(rawValue: kind) }

    /// True for kinds that ask the hiker to change direction.
    public var isManeuver: Bool {
        kind == WaypointKind.bear.rawValue
            || kind == WaypointKind.turn.rawValue
            || kind == WaypointKind.switchback.rawValue
    }
}

/// Aggregate route statistics as shipped in the pack.
public struct RouteStats: Codable, Sendable {
    public let lengthM: Double
    public let gainM: Double
    public let lossM: Double
    public let minEle: Double
    public let maxEle: Double
    /// Naismith-style estimate in minutes.
    public let estMin: Double
}

/// A full route as stored in `routes/<id>.json` inside a region pack.
/// `coords` are `[lon, lat, ele]` triples resampled at roughly 12 m;
/// `cum` is the cumulative distance in meters with the same length.
public struct RouteData: Codable, Sendable {
    public let id: String
    public let region: String?
    public let name: String
    public let blurb: String?
    public let loop: Bool?
    public let coords: [[Double]]
    public let cum: [Double]
    public let waypoints: [Waypoint]
    public let stats: RouteStats
    /// File name of the high-resolution AR terrain patch, if any.
    public let arPatch: String?

    /// Total length in meters, from the cumulative array.
    public var lengthM: Double { cum.last ?? 0 }

    /// Coordinate helpers. Route packs always ship 3-element triples; these
    /// guard against short arrays instead of trapping.
    public func lonLat(at index: Int) -> LonLat {
        let c = coords[index]
        return LonLat(lon: c.count > 0 ? c[0] : 0, lat: c.count > 1 ? c[1] : 0)
    }

    public func ele(at index: Int) -> Double {
        let c = coords[index]
        return c.count > 2 ? c[2] : 0
    }
}

/// Result of snapping a position onto the route polyline.
public struct Snap: Sendable {
    /// Index of the nearest segment (between coords[seg] and coords[seg+1]).
    public let seg: Int
    /// Parameter along that segment in [0, 1].
    public let t: Double
    /// Distance from the route start to the snapped point, meters.
    public let alongM: Double
    /// Perpendicular distance from the position to the route, meters.
    public let offM: Double
    /// The snapped point on the route.
    public let lon: Double
    public let lat: Double
}

/// A point sampled at a given distance along the route.
public struct AlongPoint: Sendable {
    public let lon: Double
    public let lat: Double
    public let ele: Double
    /// Bearing of the segment the point lies on, degrees.
    public let bearing: Double
    public let seg: Int

    public var lonLat: LonLat { LonLat(lon: lon, lat: lat) }
}

/// Geographic bounds of a route.
public struct RouteBounds: Sendable {
    public let west: Double
    public let south: Double
    public let east: Double
    public let north: Double
}

/// A route plus precomputed planar geometry: a local East-North frame
/// anchored at the first vertex, projected xy pairs, and the remaining
/// climb from every vertex to the end. Mirrors the web PreparedRoute.
public struct PreparedRoute: Sendable {
    public let data: RouteData
    public let frame: LocalFrame
    /// Local planar coordinates, `xy[2*i]` = x east, `xy[2*i+1]` = y north.
    public let xy: [Double]
    /// Remaining climb in meters from vertex i to the end (suffix sum of
    /// positive elevation deltas).
    public let remGain: [Double]

    public var coords: [[Double]] { data.coords }
    public var cum: [Double] { data.cum }
    public var waypoints: [Waypoint] { data.waypoints }
    public var stats: RouteStats { data.stats }
    public var name: String { data.name }
    public var id: String { data.id }
    public var lengthM: Double { data.lengthM }

    /// Prepares a route for navigation. Routes with fewer than two vertices
    /// or mismatched arrays return nil rather than producing nonsense.
    public init?(_ r: RouteData) {
        let n = r.coords.count
        guard n >= 2, r.cum.count == n else { return nil }
        guard let first = r.coords.first, first.count >= 2 else { return nil }

        self.data = r
        let frame = LocalFrame(lon0: first[0], lat0: first[1])
        self.frame = frame

        var xy = [Double](repeating: 0, count: n * 2)
        for i in 0..<n {
            let p = frame.toXY(lon: r.coords[i][0], lat: r.coords[i][1])
            xy[i * 2] = p.x
            xy[i * 2 + 1] = p.y
        }
        self.xy = xy

        var remGain = [Double](repeating: 0, count: n)
        if n >= 2 {
            for i in stride(from: n - 2, through: 0, by: -1) {
                let d = r.ele(at: i + 1) - r.ele(at: i)
                remGain[i] = remGain[i + 1] + (d > 0 ? d : 0)
            }
        }
        self.remGain = remGain
    }

    /// Snaps a position to the nearest point on the route polyline by
    /// scanning every segment in the local planar frame.
    public func snap(lon: Double, lat: Double) -> Snap {
        let p = frame.toXY(lon: lon, lat: lat)
        let n = coords.count
        var bestD2 = Double.infinity
        var bestSeg = 0
        var bestT = 0.0
        var bestX = xy[0]
        var bestY = xy[1]
        for i in 0..<(n - 1) {
            let pr = projectOnSegment(
                px: p.x, py: p.y,
                ax: xy[i * 2], ay: xy[i * 2 + 1],
                bx: xy[i * 2 + 2], by: xy[i * 2 + 3]
            )
            if pr.d2 < bestD2 {
                bestD2 = pr.d2
                bestSeg = i
                bestT = pr.t
                bestX = pr.x
                bestY = pr.y
            }
        }
        let segLen = cum[bestSeg + 1] - cum[bestSeg]
        let alongM = cum[bestSeg] + segLen * bestT
        let snapped = frame.toLonLat(x: bestX, y: bestY)
        return Snap(
            seg: bestSeg, t: bestT, alongM: alongM,
            offM: bestD2.squareRoot(), lon: snapped.lon, lat: snapped.lat
        )
    }

    /// Point at a given distance along the route, clamped to its ends.
    /// Binary searches the cumulative array like the web pointAtAlong.
    public func pointAtAlong(_ m: Double) -> AlongPoint {
        let n = cum.count
        let last = cum[n - 1]
        let target = min(max(m, 0), last)
        var lo = 0
        var hi = n - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if cum[mid] <= target {
                lo = mid
            } else {
                hi = mid
            }
        }
        var segLen = cum[hi] - cum[lo]
        if segLen == 0 { segLen = 1 }
        let t = (target - cum[lo]) / segLen
        let a = coords[lo]
        let b = coords[hi]
        let lon = a[0] + (b[0] - a[0]) * t
        let lat = a[1] + (b[1] - a[1]) * t
        let ea = a.count > 2 ? a[2] : 0
        let eb = b.count > 2 ? b[2] : 0
        let ele = ea + (eb - ea) * t
        let brg = bearingDeg(from: LonLat(lon: a[0], lat: a[1]), to: LonLat(lon: b[0], lat: b[1]))
        return AlongPoint(lon: lon, lat: lat, ele: ele, bearing: brg, seg: lo)
    }

    /// The coordinate a waypoint is attached to.
    public func waypointLonLat(_ wp: Waypoint) -> LonLat {
        data.lonLat(at: min(wp.i, coords.count - 1))
    }

    /// Elevation at a waypoint's vertex.
    public func waypointEle(_ wp: Waypoint) -> Double {
        data.ele(at: min(wp.i, coords.count - 1))
    }

    /// Axis-aligned geographic bounds of the polyline.
    public var bounds: RouteBounds {
        var west = Double.infinity
        var south = Double.infinity
        var east = -Double.infinity
        var north = -Double.infinity
        for c in coords where c.count >= 2 {
            if c[0] < west { west = c[0] }
            if c[0] > east { east = c[0] }
            if c[1] < south { south = c[1] }
            if c[1] > north { north = c[1] }
        }
        return RouteBounds(west: west, south: south, east: east, north: north)
    }
}
