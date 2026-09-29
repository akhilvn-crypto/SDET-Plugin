package com.sdet.mobile.core;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/** Reads settings: -D system property > environment variable > config.properties. */
public final class Config {

    private static final Properties FILE = new Properties();

    static {
        try (InputStream in = Config.class.getClassLoader().getResourceAsStream("config.properties")) {
            if (in != null) {
                FILE.load(in);
            }
        } catch (IOException e) {
            throw new IllegalStateException("Cannot read config.properties", e);
        }
    }

    private Config() {
    }

    public static String get(String key) {
        String value = System.getProperty(key);
        if (isBlank(value)) {
            value = System.getenv(key.toUpperCase().replace('.', '_'));
        }
        if (isBlank(value)) {
            value = FILE.getProperty(key);
        }
        return isBlank(value) ? null : value.trim();
    }

    public static String get(String key, String fallback) {
        String value = get(key);
        return value == null ? fallback : value;
    }

    public static String required(String key) {
        String value = get(key);
        if (value == null) {
            throw new IllegalStateException("Missing setting '" + key + "' (config.properties, -D" + key + " or env var)");
        }
        return value;
    }

    public static boolean flag(String key, boolean fallback) {
        String value = get(key);
        return value == null ? fallback : Boolean.parseBoolean(value);
    }

    public static int number(String key, int fallback) {
        String value = get(key);
        return value == null ? fallback : Integer.parseInt(value);
    }

    /** Credentials and other secrets come from environment variables only - never from files in the repo. */
    public static String secret(String envVar) {
        String value = System.getenv(envVar);
        if (isBlank(value)) {
            throw new IllegalStateException("Environment variable " + envVar + " is not set (see .env.example)");
        }
        return value;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
