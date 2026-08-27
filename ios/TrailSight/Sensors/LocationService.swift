//
//  LocationService.swift
//  TrailSight
//
//  Thin observable wrapper around CLLocationManager. Publishes the latest
//  fix, compass heading, and authorization state for SwiftUI and the AR
//  layer. GPS drives geographic position; ARKit drives orientation while
//  an AR session runs, with the compass heading kept for the HUD tape and
//  for degraded, non-AR guidance.
//

import CoreLocation
import Foundation
import Observation

/// Simplified authorization state for the UI.
public enum LocationPermission: String, Sendable {
    case unknown
    case granted
    case denied
}

/// Observable GPS and compass source. Create once and share; delegate
/// callbacks arrive on the main run loop, so observed properties update on
/// the main thread.
@Observable
public final class LocationService: NSObject, CLLocationManagerDelegate {
    /// Latest fix, nil until the first update after start().
    public private(set) var lastLocation: CLLocation?
    /// Compass heading in degrees true north, nil before the first heading
    /// event. Falls back to magnetic heading when true heading is unknown.
    public private(set) var headingDeg: Double?
    /// Reported heading accuracy in degrees; large values mean the compass
    /// needs calibration (figure-eight wave).
    public private(set) var headingAccuracyDeg: Double = 180
    public private(set) var permission: LocationPermission = .unknown
    public private(set) var isUpdating = false
    /// Human readable reason when something goes wrong.
    public private(set) var errorMessage: String?

    private let manager = CLLocationManager()

    override public init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .fitness
        manager.headingFilter = 2
    }

    /// Asks for when-in-use authorization if not yet determined.
    public func requestPermission() {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    /// Starts high-accuracy location and heading updates. Call after
    /// permission is granted; safe to call repeatedly.
    public func start() {
        guard !isUpdating else { return }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        }
        isUpdating = true
    }

    /// Stops all updates, e.g. when navigation ends.
    public func stop() {
        guard isUpdating else { return }
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
        isUpdating = false
    }

    /// Latest position as engine types: coordinate, ellipsoid-free MSL
    /// elevation, and horizontal accuracy in meters.
    public var fix: (lonLat: LonLat, ele: Double, accuracy: Double)? {
        guard let loc = lastLocation else { return nil }
        return (
            LonLat(lon: loc.coordinate.longitude, lat: loc.coordinate.latitude),
            loc.altitude,
            loc.horizontalAccuracy
        )
    }

    /// True when the compass error is small enough for confident AR
    /// alignment; below this the HUD shows a calibration hint.
    public var headingIsReliable: Bool {
        headingAccuracyDeg >= 0 && headingAccuracyDeg <= 25
    }

    // MARK: CLLocationManagerDelegate

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            permission = .granted
            start()
        case .denied, .restricted:
            permission = .denied
        case .notDetermined:
            permission = .unknown
        @unknown default:
            permission = .unknown
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last, loc.horizontalAccuracy >= 0 else { return }
        lastLocation = loc
        errorMessage = nil
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        headingAccuracyDeg = newHeading.headingAccuracy
        if newHeading.trueHeading >= 0 {
            headingDeg = newHeading.trueHeading
        } else if newHeading.magneticHeading >= 0 {
            headingDeg = newHeading.magneticHeading
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as NSError).code
        // kCLErrorLocationUnknown is transient; keep quiet about it.
        if code != CLError.locationUnknown.rawValue {
            errorMessage = error.localizedDescription
        }
    }
}
