//
//  Geo.swift
//  TrailSight
//
//  Geodesy helpers, a direct port of the web app's geo.ts so both clients
//  agree on every number. Distances are meters, angles are degrees unless
//  noted. Headings are compass bearings: 0 = north, clockwise positive.
//

import Foundation

/// Mean Earth radius in meters, matching the web engine.
public let earthRadiusM: Double = 6_371_000

private let d2r = Double.pi / 180
private let r2d = 180 / Double.pi

/// A geographic coordinate. `lon` is degrees east, `lat` degrees north.
public struct LonLat: Equatable, Sendable {
    public var lon: Double
    public var lat: Double

    public init(lon: Double, lat: Double) {
        self.lon = lon
        self.lat = lat
    }

    /// Builds from a `[lon, lat, ...]` JSON array slice, the format used by
    /// region packs. Returns nil if fewer than two elements are present.
    public init?(array: [Double]) {
        guard array.count >= 2 else { return nil }
        self.init(lon: array[0], lat: array[1])
    }
}

/// A fused position and orientation sample used by the nav engine and HUD.
public struct Pose: Sendable {
    public var lon: Double
    public var lat: Double
    /// Elevation in meters above sea level.
    public var ele: Double
    /// Compass heading in degrees, 0 = north, clockwise.
    public var heading: Double
    /// Camera pitch in degrees, 0 = level, positive looking up.
    public var pitch: Double
    /// Horizontal accuracy in meters.
    public var accuracy: Double
    public var speedMps: Double
    /// Timestamp in seconds since reference date.
    public var ts: Double

    public init(
        lon: Double, lat: Double, ele: Double, heading: Double,
        pitch: Double = 0, accuracy: Double = 5, speedMps: Double = 0, ts: Double = 0
    ) {
        self.lon = lon
        self.lat = lat
        self.ele = ele
        self.heading = heading
        self.pitch = pitch
        self.accuracy = accuracy
        self.speedMps = speedMps
        self.ts = ts
    }

    public var lonLat: LonLat { LonLat(lon: lon, lat: lat) }
}

/// Clamps `v` into `[lo, hi]`.
public func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
    min(hi, max(lo, v))
}

/// Linear interpolation between `a` and `b`.
public func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
    a + (b - a) * t
}

/// Wraps any angle into `[0, 360)`.
public func wrap360(_ deg: Double) -> Double {
    let m = deg.truncatingRemainder(dividingBy: 360)
    return (m + 360).truncatingRemainder(dividingBy: 360)
}

/// Signed smallest rotation from `from` to `to`, in `[-180, 180)`.
public func angDiffDeg(from: Double, to: Double) -> Double {
    let raw = (to - from + 540).truncatingRemainder(dividingBy: 360)
    return (raw + 360).truncatingRemainder(dividingBy: 360) - 180
}

/// Interpolates compass angles along the shortest arc.
public func lerpAngleDeg(_ a: Double, _ b: Double, _ t: Double) -> Double {
    wrap360(a + angDiffDeg(from: a, to: b) * t)
}

/// Great-circle distance between two coordinates in meters (haversine).
public func haversineM(_ a: LonLat, _ b: LonLat) -> Double {
    let p1 = a.lat * d2r
    let p2 = b.lat * d2r
    let dp = p2 - p1
    let dl = (b.lon - a.lon) * d2r
    let sinDp = sin(dp / 2)
    let sinDl = sin(dl / 2)
    let s = sinDp * sinDp + cos(p1) * cos(p2) * sinDl * sinDl
    return 2 * earthRadiusM * asin(sqrt(s))
}

/// Initial compass bearing from `a` to `b`, degrees in `[0, 360)`.
public func bearingDeg(from a: LonLat, to b: LonLat) -> Double {
    let p1 = a.lat * d2r
    let p2 = b.lat * d2r
    let dl = (b.lon - a.lon) * d2r
    let y = sin(dl) * cos(p2)
    let x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
    return wrap360(atan2(y, x) * r2d)
}

/// Destination point given a start, a bearing, and a distance in meters.
public func destPoint(from a: LonLat, bearingDeg brg: Double, distanceM: Double) -> LonLat {
    let br = brg * d2r
    let d = distanceM / earthRadiusM
    let p1 = a.lat * d2r
    let l1 = a.lon * d2r
    let p2 = asin(sin(p1) * cos(d) + cos(p1) * sin(d) * cos(br))
    let l2 = l1 + atan2(sin(br) * sin(d) * cos(p1), cos(d) - sin(p1) * sin(p2))
    return LonLat(lon: wrap360(l2 * r2d + 180) - 180, lat: p2 * r2d)
}

/// Flat local East-North frame around a reference point. Good to well under
/// 0.1 percent error at region scale (tens of km). x = meters east of the
/// origin, y = meters north of the origin. This is the same equirectangular
/// approximation the web engine uses, and it is also the horizontal part of
/// the ENU frame the AR layer places content in.
public struct LocalFrame: Sendable {
    public let lon0: Double
    public let lat0: Double
    /// Meters per degree of longitude at the origin latitude.
    public let kx: Double
    /// Meters per degree of latitude.
    public let ky: Double

    public init(lon0: Double, lat0: Double) {
        self.lon0 = lon0
        self.lat0 = lat0
        self.kx = 111_320 * cos(lat0 * d2r)
        self.ky = 110_574
    }

    /// Projects a coordinate to local meters (x east, y north).
    public func toXY(lon: Double, lat: Double) -> (x: Double, y: Double) {
        ((lon - lon0) * kx, (lat - lat0) * ky)
    }

    public func toXY(_ p: LonLat) -> (x: Double, y: Double) {
        toXY(lon: p.lon, lat: p.lat)
    }

    /// Inverse of `toXY`.
    public func toLonLat(x: Double, y: Double) -> LonLat {
        LonLat(lon: lon0 + x / kx, lat: lat0 + y / ky)
    }
}

/// Result of projecting a point onto a segment: clamped parameter `t`,
/// the closest point, and the squared distance to it.
public struct SegmentProjection: Sendable {
    public let t: Double
    public let x: Double
    public let y: Double
    public let d2: Double
}

/// Projects point `(px, py)` onto segment `(ax, ay)-(bx, by)` in the plane.
public func projectOnSegment(
    px: Double, py: Double,
    ax: Double, ay: Double,
    bx: Double, by: Double
) -> SegmentProjection {
    let dx = bx - ax
    let dy = by - ay
    let seg2 = dx * dx + dy * dy
    var t = 0.0
    if seg2 > 0 {
        t = clamp(((px - ax) * dx + (py - ay) * dy) / seg2, 0, 1)
    }
    let x = ax + t * dx
    let y = ay + t * dy
    let ex = px - x
    let ey = py - y
    return SegmentProjection(t: t, x: x, y: y, d2: ex * ex + ey * ey)
}

/// 16-wind compass name for a bearing, e.g. 22 degrees -> "NNE".
public func compass16(_ deg: Double) -> String {
    let names = [
        "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
    ]
    let idx = Int((wrap360(deg) / 22.5).rounded()) % 16
    return names[idx]
}
