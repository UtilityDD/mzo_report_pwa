<?php
// --- CORS HEADERS ---
header("Access-Control-Allow-Origin: *"); // Or restrict to specific origin
header("Access-Control-Allow-Headers: Content-Type");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");

// Handle preflight request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// --- SET CONTENT TYPE TO JSON ---
header("Content-Type: application/json");

// --- DATABASE CREDENTIALS ---
$host = "localhost";
$dbname = "u216934743_dc";
$username = "u216934743_dc";
$password = "Raja!2025";

try {
    // --- CONNECT TO DATABASE ---
    $pdo = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8", $username, $password);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    // --- FETCH DATA ---
    $stmt = $pdo->prepare("SELECT consumer_id,dc_date,paid_date,agency,base_class,ccc_code FROM dclist");
    $stmt->execute();

    $results = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "data" => $results
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Database error: " . $e->getMessage()
    ]);
}
