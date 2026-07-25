cmake_minimum_required(VERSION 3.10)
project(station_scanner)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Release build by default (OCR + JPEG encode benefit from optimization)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(OpenCV REQUIRED)
find_package(Threads REQUIRED)
find_package(PkgConfig REQUIRED)
find_package(CURL REQUIRED)

# ZBar has no CMake config on most systems, so we use pkg-config for it
pkg_check_modules(ZBAR REQUIRED zbar)

# Tesseract + Leptonica (OCR engine + its image library dependency)
pkg_check_modules(TESSERACT REQUIRED tesseract)
pkg_check_modules(LEPTONICA REQUIRED lept)

include_directories(
    ${OpenCV_INCLUDE_DIRS}
    ${ZBAR_INCLUDE_DIRS}
    ${TESSERACT_INCLUDE_DIRS}
    ${LEPTONICA_INCLUDE_DIRS}
    ${CURL_INCLUDE_DIRS}
)

link_directories(
    ${ZBAR_LIBRARY_DIRS}
    ${TESSERACT_LIBRARY_DIRS}
    ${LEPTONICA_LIBRARY_DIRS}
)

add_executable(station_scanner main.cpp)

target_link_libraries(station_scanner
    ${OpenCV_LIBS}
    ${ZBAR_LIBRARIES}
    ${TESSERACT_LIBRARIES}
    ${LEPTONICA_LIBRARIES}
    ${CURL_LIBRARIES}
    Threads::Threads
)

# focus_check.cpp is only built if it exists in this folder -- keeps a
# fresh checkout from failing to configure if that file isn't present yet.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/focus_check.cpp")
    add_executable(focus_check focus_check.cpp)
    target_link_libraries(focus_check ${OpenCV_LIBS} ${TESSERACT_LIBRARIES} ${LEPTONICA_LIBRARIES})
endif()