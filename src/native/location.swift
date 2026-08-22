import CoreLocation
import Foundation

final class LocationRequest: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private(set) var finished = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        manager.distanceFilter = kCLDistanceFilterNone
    }

    func start() {
        guard CLLocationManager.locationServicesEnabled() else {
            finish(success: false, status: "services-disabled", message: "macOS location services are disabled.")
            return
        }
        handleAuthorization(manager.authorizationStatus)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        handleAuthorization(manager.authorizationStatus)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last(where: { $0.horizontalAccuracy >= 0 }) else { return }
        let latitude = (location.coordinate.latitude * 100).rounded() / 100
        let longitude = (location.coordinate.longitude * 100).rounded() / 100
        finish(success: true, status: "authorized", latitude: latitude, longitude: longitude)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as? CLError)?.code
        if code == .locationUnknown { return }
        finish(success: false, status: "unavailable", message: "Core Location could not provide a position.")
    }

    func timeout() {
        finish(success: false, status: "timeout", message: "Core Location timed out.")
    }

    private func handleAuthorization(_ status: CLAuthorizationStatus) {
        guard !finished else { return }
        switch status {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied:
            finish(success: false, status: "denied", message: "Location permission was denied.")
        case .restricted:
            finish(success: false, status: "restricted", message: "Location permission is restricted.")
        @unknown default:
            finish(success: false, status: "unknown", message: "Location authorization state is unknown.")
        }
    }

    private func finish(
        success: Bool,
        status: String,
        latitude: Double? = nil,
        longitude: Double? = nil,
        message: String? = nil
    ) {
        guard !finished else { return }
        finished = true
        manager.stopUpdatingLocation()
        var payload: [String: Any] = [
            "success": success,
            "status": status,
            "precisionKm": 1
        ]
        if let latitude { payload["latitude"] = latitude }
        if let longitude { payload["longitude"] = longitude }
        if let message { payload["message"] = message }
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let output = String(data: data, encoding: .utf8) {
            FileHandle.standardOutput.write(Data(output.utf8))
        }
    }
}

let request = LocationRequest()
let timeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { _ in request.timeout() }
request.start()
while !request.finished && RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.25)) {}
timeout.invalidate()

