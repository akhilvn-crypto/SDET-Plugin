package com.sdet.mobile.core;

import io.appium.java_client.android.AndroidDriver;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.logging.LogEntry;
import org.testng.ITestResult;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.stream.Collectors;

/**
 * One fresh Appium session per test. On failure it saves the evidence the pipeline and
 * bug-reporter read: target/evidence/<Class.method>/ screenshot.png, page-source.xml,
 * logcat.txt, recording.mp4 (when record.video=true) and failure.txt.
 */
public abstract class BaseTest {

    protected AndroidDriver driver;
    private boolean recording;

    @BeforeMethod(alwaysRun = true)
    public void startSession(Method method) {
        driver = DriverFactory.start();
        flushLogcat();
        if (Config.flag("record.video", true)) {
            try {
                driver.startRecordingScreen();
                recording = true;
            } catch (RuntimeException e) {
                recording = false; // some devices/emulators can't record - evidence is still captured without it
            }
        }
    }

    @AfterMethod(alwaysRun = true)
    public void endSession(ITestResult result) {
        try {
            if (driver != null && result.getStatus() == ITestResult.FAILURE) {
                captureEvidence(result);
            } else if (driver != null && recording) {
                driver.stopRecordingScreen();
            }
        } catch (RuntimeException ignored) {
            // evidence capture must never hide the real test failure
        } finally {
            recording = false;
            DriverFactory.quit();
        }
    }

    private void captureEvidence(ITestResult result) {
        Path dir = Path.of("target", "evidence", result.getTestClass().getRealClass().getSimpleName() + "." + result.getMethod().getMethodName());
        try {
            Files.createDirectories(dir);
            Files.write(dir.resolve("screenshot.png"), driver.getScreenshotAs(OutputType.BYTES));
            Files.writeString(dir.resolve("page-source.xml"), driver.getPageSource(), StandardCharsets.UTF_8);
            Files.writeString(dir.resolve("logcat.txt"), readLogcat(), StandardCharsets.UTF_8);
            Files.writeString(dir.resolve("failure.txt"),
                    "Test: " + result.getMethod().getDescription() + System.lineSeparator()
                            + "Activity: " + safeActivity() + System.lineSeparator()
                            + "Error: " + result.getThrowable(), StandardCharsets.UTF_8);
            if (recording) {
                Files.write(dir.resolve("recording.mp4"), Base64.getMimeDecoder().decode(driver.stopRecordingScreen()));
            }
        } catch (IOException | RuntimeException e) {
            System.err.println("Could not save all failure evidence to " + dir + ": " + e.getMessage());
        }
    }

    private void flushLogcat() {
        try {
            driver.manage().logs().get("logcat"); // reading drains the buffer, so the failure log only holds this test
        } catch (RuntimeException ignored) {
            // logcat not available through this server - the runner falls back to `adb logcat -d`
        }
    }

    private String readLogcat() {
        try {
            return driver.manage().logs().get("logcat").getAll().stream()
                    .map(LogEntry::toString)
                    .collect(Collectors.joining(System.lineSeparator()));
        } catch (RuntimeException e) {
            return "logcat unavailable through Appium (" + e.getMessage() + ") - use `adb logcat -d`";
        }
    }

    private String safeActivity() {
        try {
            return driver.getCurrentPackage() + "/" + driver.currentActivity();
        } catch (RuntimeException e) {
            return "unknown";
        }
    }
}
