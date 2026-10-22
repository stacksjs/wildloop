import XCTest

/// The installed Wildloop, and the few bits of the system around it.
///
/// Nothing here builds the app. Craft owns the Xcode project and regenerates
/// it, so these tests attach to whatever is installed by bundle id — which is
/// also why the same test runs against a simulator and a phone unchanged.
enum Wildloop {
    // Set but empty is the normal case, not an edge one: the scheme carries
    // every variable xcodegen substituted, and an unset one substitutes to "".
    // Read as `?? default` that empty string wins, and the app launches by a
    // bundle id of "" — which fails with FBSApplicationLibrary returning nil
    // for "", a long way from anything that names the cause.
    static let bundleId = value(of: "WILDLOOP_BUNDLE_ID") ?? "org.wildloop.app"

    static func app() -> XCUIApplication {
        XCUIApplication(bundleIdentifier: bundleId)
    }

    static var springboard: XCUIApplication {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
    }

    /// The seeded staging account, passed in by the runner as
    /// `TEST_RUNNER_E2E_EMAIL` / `TEST_RUNNER_E2E_PASSWORD` — the same pair the
    /// Maestro flows take, so there is one set of test credentials, not two.
    static var credentials: (email: String, password: String)? {
        // Either spelling: `xcodebuild` is documented to strip the
        // `TEST_RUNNER_` prefix on the way into the runner, and does not
        // always, so the test reads both rather than skipping itself over it.
        guard let email = value(of: "E2E_EMAIL"), let password = value(of: "E2E_PASSWORD") else { return nil }
        return (email, password)
    }

    static func value(of name: String) -> String? {
        let environment = ProcessInfo.processInfo.environment
        for key in [name, "TEST_RUNNER_\(name)"] {
            if let found = environment[key], !found.isEmpty { return found }
        }
        return nil
    }
}

extension XCTestCase {
    /// Wait for an element, failing with something that names what was missing.
    @discardableResult
    func expect(_ element: XCUIElement, _ what: String, within seconds: TimeInterval = 30) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: seconds), "never saw \(what)")
        return element
    }

    /// Assert an element does *not* turn up. Takes the full wait every time, so
    /// it is used sparingly and only where its absence is the whole point.
    func expectAbsent(_ element: XCUIElement, _ what: String, within seconds: TimeInterval = 5) {
        let appeared = element.waitForExistence(timeout: seconds)
        XCTAssertFalse(appeared, "\(what) turned up, and should not have")
    }

    /// Sign in through the form, the way the Maestro journey does. Craft does
    /// not pass launch arguments or environment through to the screen's JS
    /// context, so there is no way to hand the app a session from out here —
    /// and a deep link that carried one would be an auth bypass shipped in the
    /// real app. Typing it is the honest option.
    func signIn(_ app: XCUIApplication) throws {
        guard let account = Wildloop.credentials else {
            throw XCTSkip("Set E2E_EMAIL and E2E_PASSWORD to run the signed-in tests.")
        }
        let email = expect(app.textFields["login-email"], "the email field")
        email.tap()
        email.typeText(account.email)

        let password = expect(app.secureTextFields["login-password"], "the password field")
        password.tap()
        password.typeText(account.password)

        app.buttons["login-submit"].tap()
        dismissPasswordSavePrompt()
    }

    /// iOS offers to save the password it just saw typed.
    ///
    /// It is SpringBoard's, not the app's, and it covers the screen the test
    /// is waiting on — so a run that ignores it waits out its timeout and then
    /// reports whatever it was looking for as missing. It only appears on a
    /// device that has not answered it before, which is why this surfaced on a
    /// freshly created simulator and not on the one used the day before.
    ///
    /// An `addUIInterruptionMonitor` would also do it, but only fires once the
    /// test touches a blocked element; this asks directly and stays quiet when
    /// there is nothing to dismiss.
    func dismissPasswordSavePrompt() {
        let notNow = Wildloop.springboard.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 5) {
            notNow.tap()
        }
    }
}
