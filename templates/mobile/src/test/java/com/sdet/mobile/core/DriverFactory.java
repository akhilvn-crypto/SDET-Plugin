package com.sdet.mobile.core;

import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.options.UiAutomator2Options;

import java.net.MalformedURLException;
import java.net.URI;
import java.time.Duration;

/** Creates and holds the Appium session for the current test thread. */
public final class DriverFactory {

    private static final ThreadLocal<AndroidDriver> DRIVER = new ThreadLocal<>();

    private DriverFactory() {
    }

    public static AndroidDriver start() {
        UiAutomator2Options options = new UiAutomator2Options()
                .setPlatformName(Config.get("platform.name", "Android"))
                .setAutomationName(Config.get("automation.name", "UiAutomator2"))
                .setAppPackage(Config.required("app.package"))
                .setAppActivity(Config.required("app.activity"))
                .setNoReset(Config.flag("no.reset", true))
                .setAutoGrantPermissions(true)
                .setNewCommandTimeout(Duration.ofSeconds(300))
                .setDisableWindowAnimation(true);

        String udid = Config.get("device.udid");
        if (udid != null) {
            options.setUdid(udid);
        }
        String app = Config.get("app.path");
        if (app != null) {
            options.setApp(app);
        }

        try {
            AndroidDriver driver = new AndroidDriver(URI.create(Config.get("appium.url", "http://127.0.0.1:4723")).toURL(), options);
            DRIVER.set(driver);
            return driver;
        } catch (MalformedURLException e) {
            throw new IllegalStateException("Invalid appium.url", e);
        }
    }

    public static AndroidDriver get() {
        AndroidDriver driver = DRIVER.get();
        if (driver == null) {
            throw new IllegalStateException("No Appium session - is the test extending BaseTest?");
        }
        return driver;
    }

    public static void quit() {
        AndroidDriver driver = DRIVER.get();
        if (driver != null) {
            try {
                driver.quit();
            } finally {
                DRIVER.remove();
            }
        }
    }
}
