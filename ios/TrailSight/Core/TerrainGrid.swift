//
//  TerrainGrid.swift
//  TrailSight
//
//  Digital elevation model: an int16 grid inside a mercator-aligned bbox.
//  Binary layout ("TER1", little endian):
//    4 bytes magic "TER1"
//    uint32 w, uint32 h
//    float64 west, south, east, north (degrees)
//    w*h int16 elevations in meters, row 0 = north
//  Rows are spaced equally in web mercator y, not in linear latitude, so the
//  bilinear sampler interpolates in mercator y exactly like the web app's
//  terrain.ts. Keeping the two samplers identical means the AR path height
//  and the web 3D preview agree everywhere.
//

import Foundation

/// Errors thrown while decoding a `terrain.bin` / AR patch file.
public enum TerrainDecodeError: Error, LocalizedError {
    case tooSmall
    case badMagic
    case sizeMismatch(expected: Int, actual: Int)

    public var errorDescription: String? {
        switch self {
        case .tooSmall:
            return "Terrain file is too small to contain a TER1 header"
        case .badMagic:
            return "Terrain file does not start with the TER1 magic"
        case .sizeMismatch(let expected, let actual):
            return "Terrain sample count mismatch: expected \(expected), got \(actual)"
        }
    }
}

/// An immutable elevation grid with a mercator-aware bilinear sampler and a
/// coarse line-of-sight test. All elevations are meters above sea level.
public final class TerrainGrid {
    public let w: Int
    public let h: Int
    public let west: Double
    public let south: Double
    public let east: Double
    public let north: Double
    /// Row-major samples, row 0 = the northern edge.
    public let data: [Int16]

    /// Mercator y of the north and south edges, precomputed for sampling.
    public let yN: Double
    public let yS: Double

    private var cachedRange: (min: Double, max: Double)?
    private let rangeLock = NSLock()

    public init(w: Int, h: Int, west: Double, south: Double, east: Double, north: Double, data: [Int16]) {
        self.w = w
        self.h = h
        self.west = west
        self.south = south
        self.east = east
        self.north = north
        self.data = data
        self.yN = TerrainGrid.mercY(north)
        self.yS = TerrainGrid.mercY(south)
    }

    /// Web mercator y for a latitude in degrees.
    public static func mercY(_ latDeg: Double) -> Double {
        let r = latDeg * Double.pi / 180
        return log(tan(r) + 1 / cos(r))
    }

    /// Decodes a TER1 buffer. Throws `TerrainDecodeError` on malformed input.
    public static func decode(_ buf: Data) throws -> TerrainGrid {
        let headerBytes = 4 + 4 + 4 + 8 * 4
        guard buf.count >= headerBytes else { throw TerrainDecodeError.tooSmall }

        // Data slices can have a nonzero start index; normalize to base 0.
        let bytes = [UInt8](buf)

        guard bytes[0] == UInt8(ascii: "T"),
              bytes[1] == UInt8(ascii: "E"),
              bytes[2] == UInt8(ascii: "R"),
              bytes[3] == UInt8(ascii: "1")
        else { throw TerrainDecodeError.badMagic }

        func u32(_ offset: Int) -> UInt32 {
            var v: UInt32 = 0
            for i in 0..<4 {
                v |= UInt32(bytes[offset + i]) << (8 * i)
            }
            return v
        }
        func f64(_ offset: Int) -> Double {
            var bits: UInt64 = 0
            for i in 0..<8 {
                bits |= UInt64(bytes[offset + i]) << (8 * i)
            }
            return Double(bitPattern: bits)
        }

        let w = Int(u32(4))
        let h = Int(u32(8))
        let west = f64(12)
        let south = f64(20)
        let east = f64(28)
        let north = f64(36)

        let count = w * h
        let available = (bytes.count - headerBytes) / 2
        guard available == count, count > 0 else {
            throw TerrainDecodeError.sizeMismatch(expected: count, actual: max(available, 0))
        }

        var data = [Int16](repeating: 0, count: count)
        for i in 0..<count {
            let o = headerBytes + i * 2
            let lo = UInt16(bytes[o])
            let hi = UInt16(bytes[o + 1])
            data[i] = Int16(bitPattern: lo | (hi << 8))
        }
        return TerrainGrid(w: w, h: h, west: west, south: south, east: east, north: north, data: data)
    }

    /// True if the coordinate falls inside the grid bbox.
    public func contains(lon: Double, lat: Double) -> Bool {
        lon >= west && lon <= east && lat >= south && lat <= north
    }

    /// Bilinear elevation in meters. Coordinates outside the bbox clamp to
    /// the nearest edge sample, mirroring the web sampler.
    public func elevAt(lon: Double, lat: Double) -> Double {
        var fx = ((lon - west) / (east - west)) * Double(w - 1)
        var fy = ((yN - TerrainGrid.mercY(lat)) / (yN - yS)) * Double(h - 1)
        fx = min(max(fx, 0), Double(w) - 1.001)
        fy = min(max(fy, 0), Double(h) - 1.001)
        let x0 = Int(fx)
        let y0 = Int(fy)
        let dx = fx - Double(x0)
        let dy = fy - Double(y0)
        let i = y0 * w + x0
        let a = Double(data[i])
        let b = Double(data[i + 1])
        let c = Double(data[i + w])
        let d = Double(data[i + w + 1])
        return a * (1 - dx) * (1 - dy)
            + b * dx * (1 - dy)
            + c * (1 - dx) * dy
            + d * dx * dy
    }

    /// Convenience overload for `LonLat`.
    public func elevAt(_ p: LonLat) -> Double {
        elevAt(lon: p.lon, lat: p.lat)
    }

    /// Minimum and maximum sample values, computed once on demand.
    public var range: (min: Double, max: Double) {
        rangeLock.lock()
        defer { rangeLock.unlock() }
        if let cached = cachedRange { return cached }
        var lo = Double.infinity
        var hi = -Double.infinity
        for v in data {
            let dv = Double(v)
            if dv < lo { lo = dv }
            if dv > hi { hi = dv }
        }
        let result = (min: lo, max: hi)
        cachedRange = result
        return result
    }

    /// Approximate line-of-sight between two points, each at `ele` meters
    /// above sea level. Samples the terrain between them; the ray is blocked
    /// if terrain rises above the sight line by more than `slack` meters at
    /// any sample. Matches the web implementation.
    public func lineOfSight(
        aLon: Double, aLat: Double, aEle: Double,
        bLon: Double, bLat: Double, bEle: Double,
        steps: Int = 14, slack: Double = 3
    ) -> Bool {
        guard steps > 1 else { return true }
        for s in 1..<steps {
            let t = Double(s) / Double(steps)
            let lon = aLon + (bLon - aLon) * t
            let lat = aLat + (bLat - aLat) * t
            let sight = aEle + (bEle - aEle) * t
            if elevAt(lon: lon, lat: lat) > sight + slack {
                return false
            }
        }
        return true
    }
}
