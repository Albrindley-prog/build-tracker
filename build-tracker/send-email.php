<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: https://build-tracker.co.uk');
header('Access-Control-Allow-Methods: POST');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'error' => 'Wrong method']);
    exit;
}

$in = json_decode(file_get_contents('php://input'), true);
if (empty($in['customerEmail']) || empty($in['jobNumber'])) {
    echo json_encode(['success' => false, 'error' => 'Missing data']);
    exit;
}

$to = $in['customerEmail'];
$subject = "Build Complete: Job {$in['jobNumber']}";
$message = "Hello {$in['customerName']},\n\nYour build is complete.\nJob: {$in['jobNumber']}\nChassis: {$in['chassisNumber']}\nLink: {$in['portalLink']}\n\nRegards,\nBuild Tracker";

$headers = "From: info.buildtracker@gmail.com\r\nReply-To: info.buildtracker@gmail.com";

if (mail($to, $subject, $message, $headers)) {
    echo json_encode(['success' => true]);
} else {
    echo json_encode(['success' => false, 'error' => 'Mail failed']);
}
?>