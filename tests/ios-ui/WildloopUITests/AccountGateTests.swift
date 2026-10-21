import XCTest

/// The account gate, on a real iOS.
///
/// These four are the gaps Maestro cannot reach, which is the only reason this
/// target exists beside `.maestro/flows`:
///
///   - **Springboard.** Backgrounding the app and coming back runs the
///     lifecycle restore in `startNativeApp`; Maestro relaunches instead,
///     which takes a different path through the same code.
///
///     The home-screen long-press menu was meant to be here too — it is the
///     surface the App Shortcut leak came through — but it cannot be: neither
///     stx's native runtime nor craft-native has a Shortcuts module, so
///     `craft.shortcuts` does not exist in an all-native build and nothing
///     registers the quick actions. `registerAppShortcuts` answers
///     'unsupported', correctly. Siri and Spotlight are unaffected; those come
///     from the App Intents Craft generates out of config/mobile.ts.
///   - **A system permission dialog as an interruption.** Maestro polls for
///     the alert's button text; XCTest registers a monitor and the test says
///     what it expects instead of racing it.
///   - **The absence of that dialog**, which is what 04d2eec7 fixed and what a
///     unit test can only claim: the host, not the bundle, decides when a
///     hidden prepared tab runs.
///
/// Every test but the last works signed out, because the runner reinstalls the
/// app first — the equivalent of Maestro's `clearState: true`, which XCTest
/// has no API for.
final class AccountGateTests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// A fresh install opens on Login, with no tab bar behind it.
    func test1ColdLaunchMeetsTheGate() {
        let app = Wildloop.app()
        app.launch()

        expect(app.textFields["login-email"], "the login form on a cold launch")
        XCTAssertFalse(app.buttons["craft-tab-/feed"].exists, "the tab bar is behind the gate")
        XCTAssertFalse(app.staticTexts["Feed"].exists, "the feed is behind the gate")
    }

    /// The gate holds across a trip to the home screen and back.
    ///
    /// Coming back runs `startNativeApp`'s lifecycle restore, which re-reads
    /// the session and republishes it — the one place that could hand a
    /// signed-out viewer a session that is not there. Maestro relaunches the
    /// app; this backgrounds it, which is the path that actually runs.
    func test2TheGateHoldsComingBackFromTheBackground() {
        let app = Wildloop.app()
        app.launch()
        expect(app.textFields["login-email"], "the gate")

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(
            Wildloop.springboard.wait(for: .runningForeground, timeout: 15),
            "never reached the home screen"
        )
        app.activate()

        expect(app.textFields["login-email"], "the gate after coming back")
        XCTAssertFalse(app.buttons["craft-tab-/feed"].exists, "the tab bar is still behind the gate")
    }

    /// Record is the one screen whose job is GPS, so it is the one place a
    /// location prompt is invited — and nobody has invited it yet. The tab is
    /// prepared hidden beside the Feed at launch, and asking from there put the
    /// prompt over somebody's feed on a first run (04d2eec7).
    func test3TheGateAsksForNoLocation() {
        let app = Wildloop.app()
        app.launch()
        expect(app.textFields["login-email"], "the gate")

        expectAbsent(
            Wildloop.springboard.buttons["Allow While Using App"],
            "the location prompt, over a login screen",
            within: 8
        )
    }

    /// And when somebody does open Record, the prompt is theirs to answer.
    func test4RecordAsksForLocationOnceSomebodyIsThere() throws {
        let app = Wildloop.app()
        app.launch()
        expect(app.textFields["login-email"], "the gate")
        try signIn(app)

        // `craft-tab-/record`, not a UITabBar: Craft draws the bar as plain
        // buttons, so `app.tabBars` finds nothing to query.
        expect(app.buttons["craft-tab-/record"], "the Record tab after signing in", within: 60).tap()

        let allow = Wildloop.springboard.buttons["Allow While Using App"]
        expect(allow, "the location prompt on Record", within: 20).tap()
        expect(app.buttons["record-start"], "Record, ready to start")
    }
}
