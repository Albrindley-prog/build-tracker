<?php
if ($_SERVER["REQUEST_METHOD"] === "POST") {
    // --- PUT YOUR REAL EMAIL HERE ---
    $to = "info@buildtracker.com";
    $subject = "New enquiry from Build Tracker";

    $name = htmlspecialchars($_POST['name'] ?? '');
    $email = htmlspecialchars($_POST['email'] ?? '');
    $message = htmlspecialchars($_POST['message'] ?? '');

    $body = "Name: $name\nEmail: $email\n\nMessage:\n$message";
    $headers = "From: $email";

    if (mail($to, $subject, $body, $headers)) {
        echo json_encode(["success" => true]);
    } else {
        echo json_encode(["success" => false, "error" => "Failed"]);
    }
}
?>