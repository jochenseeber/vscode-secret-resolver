import java.util.Map;

public final class TestJavaLaunch {
    private TestJavaLaunch() {}

    public static void main(String[] args) {
        System.getenv().entrySet().stream()
            .filter(TestJavaLaunch::shouldPrint)
            .sorted(Map.Entry.comparingByKey())
            .forEach(entry -> System.out.println(entry.getKey() + "=" + entry.getValue()));
    }

    private static boolean shouldPrint(Map.Entry<String, String> entry) {
        return entry.getKey().startsWith("TEST_");
    }
}